# -*- coding: utf-8 -*-

import abc
import logging
import datetime
import functools
import httplib as http
import urlparse
import uuid

from flask import request
from oauthlib.oauth2.rfc6749.errors import MissingTokenError
from requests.exceptions import HTTPError as RequestsHTTPError

from modularodm import fields, Q
from modularodm.storage.base import KeyExistsException
from modularodm.validators import URLValidator
from requests_oauthlib import OAuth1Session
from requests_oauthlib import OAuth2Session

from framework.auth import cas
from framework.exceptions import HTTPError, PermissionsError
from framework.mongo import ObjectId, StoredObject
from framework.mongo.utils import unique_on
from framework.sessions import session
from website import settings
from website.oauth.utils import PROVIDER_LOOKUP
from website.security import random_string
from website.util import web_url_for

from api.base.utils import absolute_reverse

logger = logging.getLogger(__name__)

OAUTH1 = 1
OAUTH2 = 2

generate_client_secret = functools.partial(random_string, length=40)


@unique_on(['provider', 'provider_id'])
class ExternalAccount(StoredObject):
    """An account on an external service.

    Note that this object is not and should not be aware of what other objects
    are associated with it. This is by design, and this object should be kept as
    thin as possible, containing only those fields that must be stored in the
    database.

    The ``provider`` field is a de facto foreign key to an ``ExternalProvider``
    object, as providers are not stored in the database.
    """
    _id = fields.StringField(default=lambda: str(ObjectId()), primary=True)

    # The OAuth credentials. One or both of these fields should be populated.
    # For OAuth1, this is usually the "oauth_token"
    # For OAuth2, this is usually the "access_token"
    oauth_key = fields.StringField()

    # For OAuth1, this is usually the "oauth_token_secret"
    # For OAuth2, this is not used
    oauth_secret = fields.StringField()

    # Used for OAuth2 only
    refresh_token = fields.StringField()
    expires_at = fields.DateTimeField()
    scopes = fields.StringField(list=True, default=lambda: list())

    # The `name` of the service
    # This lets us query for only accounts on a particular provider
    provider = fields.StringField(required=True)
    # The proper 'name' of the service
    # Needed for account serialization
    provider_name = fields.StringField(required=True)

    # The unique, persistent ID on the remote service.
    provider_id = fields.StringField()

    # The user's name on the external service
    display_name = fields.StringField()
    # A link to the user's profile on the external service
    profile_url = fields.StringField()

    def __repr__(self):
        return '<ExternalAccount: {}/{}>'.format(self.provider,
                                                 self.provider_id)


class ExternalProviderMeta(abc.ABCMeta):
    """Keeps track of subclasses of the ``ExternalProvider`` object"""

    def __init__(cls, name, bases, dct):
        super(ExternalProviderMeta, cls).__init__(name, bases, dct)
        if not isinstance(cls.short_name, abc.abstractproperty):
            PROVIDER_LOOKUP[cls.short_name] = cls


class ExternalProvider(object):
    """A connection to an external service (ex: GitHub).

    This object contains no credentials, and is not saved in the database.
    It provides an unauthenticated session with the provider, unless ``account``
    has been set - in which case, it provides a connection authenticated as the
    ``ExternalAccount`` instance.

    Conceptually, this can be thought of as an extension of ``ExternalAccount``.
    It's a separate object because this must be subclassed for each provider,
    and ``ExternalAccount`` instances are stored within a single collection.
    """

    __metaclass__ = ExternalProviderMeta

    # Default to OAuth v2.0.
    _oauth_version = OAUTH2

    def __init__(self):
        super(ExternalProvider, self).__init__()

        # provide an unauthenticated session by default
        self.account = None

    def __repr__(self):
        return '<{name}: {status}>'.format(
            name=self.__class__.__name__,
            status=self.account.provider_id if self.account else 'anonymous'
        )

    @abc.abstractproperty
    def auth_url_base(self):
        """The base URL to begin the OAuth dance"""
        pass

    @property
    def auth_url(self):
        """The URL to begin the OAuth dance.

        This property method has side effects - it at least adds temporary
        information to the session so that callbacks can be associated with
        the correct user.  For OAuth1, it calls the provider to obtain
        temporary credentials to start the flow.
        """

        # create a dict on the session object if it's not already there
        if session.data.get("oauth_states") is None:
            session.data['oauth_states'] = {}

        if self._oauth_version == OAUTH2:
            # build the URL
            oauth = OAuth2Session(
                self.client_id,
                redirect_uri=web_url_for('oauth_callback',
                                         service_name=self.short_name,
                                         _absolute=True),
                scope=self.default_scopes,
            )

            url, state = oauth.authorization_url(self.auth_url_base)

            # save state token to the session for confirmation in the callback
            session.data['oauth_states'][self.short_name] = {'state': state}

        elif self._oauth_version == OAUTH1:
            # get a request token
            oauth = OAuth1Session(
                client_key=self.client_id,
                client_secret=self.client_secret,
            )

            # request temporary credentials from the provider
            response = oauth.fetch_request_token(self.request_token_url)

            # store them in the session for use in the callback
            session.data['oauth_states'][self.short_name] = {
                'token': response.get('oauth_token'),
                'secret': response.get('oauth_token_secret'),
            }

            url = oauth.authorization_url(self.auth_url_base)

        return url

    @abc.abstractproperty
    def callback_url(self):
        """The provider URL to exchange the code for a token"""
        pass

    @abc.abstractproperty
    def client_id(self):
        """OAuth Client ID. a/k/a: Application ID"""
        pass

    @abc.abstractproperty
    def client_secret(self):
        """OAuth Client Secret. a/k/a: Application Secret, Application Key"""
        pass

    default_scopes = list()

    @abc.abstractproperty
    def name(self):
        """Human-readable name of the service. e.g.: ORCiD, GitHub"""
        pass

    @abc.abstractproperty
    def short_name(self):
        """Name of the service to be used internally. e.g.: orcid, github"""
        pass

    def auth_callback(self, user):
        """Exchange temporary credentials for permanent credentials

        This is called in the view that handles the user once they are returned
        to the OSF after authenticating on the external service.
        """

        # make sure the user has temporary credentials for this provider
        try:
            cached_credentials = session.data['oauth_states'][self.short_name]
        except KeyError:
            raise PermissionsError("OAuth flow not recognized.")

        if self._oauth_version == OAUTH1:
            request_token = request.args.get('oauth_token')

            # make sure this is the same user that started the flow
            if cached_credentials.get('token') != request_token:
                raise PermissionsError("Request token does not match")

            response = OAuth1Session(
                client_key=self.client_id,
                client_secret=self.client_secret,
                resource_owner_key=cached_credentials.get('token'),
                resource_owner_secret=cached_credentials.get('secret'),
                verifier=request.args.get('oauth_verifier'),
            ).fetch_access_token(self.callback_url)

        elif self._oauth_version == OAUTH2:
            state = request.args.get('state')

            # make sure this is the same user that started the flow
            if cached_credentials.get('state') != state:
                raise PermissionsError("Request token does not match")

            try:
                response = OAuth2Session(
                    self.client_id,
                    redirect_uri=web_url_for(
                        'oauth_callback',
                        service_name=self.short_name,
                        _absolute=True
                    ),
                ).fetch_token(
                    self.callback_url,
                    client_secret=self.client_secret,
                    code=request.args.get('code'),
                )
            except (MissingTokenError, RequestsHTTPError):
                raise HTTPError(http.SERVICE_UNAVAILABLE)

        # pre-set as many values as possible for the ``ExternalAccount``
        info = self._default_handle_callback(response)
        # call the hook for subclasses to parse values from the response
        info.update(self.handle_callback(response))

        try:
            # create a new ``ExternalAccount`` ...
            self.account = ExternalAccount(
                provider=self.short_name,
                provider_id=info['provider_id'],
                provider_name=self.name,
            )
            self.account.save()
        except KeyExistsException:
            # ... or get the old one
            self.account = ExternalAccount.find_one(
                Q('provider', 'eq', self.short_name) &
                Q('provider_id', 'eq', info['provider_id'])
            )
            assert self.account is not None

        # ensure that provider_name is correct
        self.account.provider_name = self.name
        # required
        self.account.oauth_key = info['key']

        # only for OAuth1
        self.account.oauth_secret = info.get('secret')

        # only for OAuth2
        self.account.expires_at = info.get('expires_at')
        self.account.refresh_token = info.get('refresh_token')

        # additional information
        self.account.display_name = info.get('display_name')
        self.account.profile_url = info.get('profile_url')

        self.account.save()

        # add it to the user's list of ``ExternalAccounts``
        if self.account not in user.external_accounts:
            user.external_accounts.append(self.account)
            user.save()

    def _default_handle_callback(self, data):
        """Parse as much out of the key exchange's response as possible.

        This should not be over-ridden in subclasses.
        """
        if self._oauth_version == OAUTH1:
            key = data.get('oauth_token')
            secret = data.get('oauth_token_secret')

            values = {}

            if key:
                values['key'] = key
            if secret:
                values['secret'] = secret

            return values

        elif self._oauth_version == OAUTH2:
            key = data.get('access_token')
            refresh_token = data.get('refresh_token')
            expires_at = data.get('expires_at')
            scopes = data.get('scope')

            values = {}

            if key:
                values['key'] = key
            if scopes:
                values['scope'] = scopes
            if refresh_token:
                values['refresh_token'] = refresh_token
            if expires_at:
                values['expires_at'] = datetime.datetime.fromtimestamp(
                    float(expires_at)
                )

            return values

    @abc.abstractmethod
    def handle_callback(self, response):
        """Hook for allowing subclasses to parse information from the callback.

        Subclasses should implement this method to provide `provider_id`
        and `profile_url`.

        Values provided by ``self._default_handle_callback`` can be over-ridden
        here as well, in the unexpected case that they are parsed incorrectly
        by default.

        :param response: The JSON returned by the provider during the exchange
        :return dict:
        """
        pass


class ApiOAuth2Application(StoredObject):
    """Registration and key for user-created OAuth API applications

    This collection is also used by CAS to create the master list of available applications.
    Any changes made to field names in this model must be echoed in the CAS implementation.
    """
    _id = fields.StringField(
        primary=True,
        default=lambda: str(ObjectId())
    )

    # Client ID and secret. Use separate ID field so ID format doesn't have to be restricted to database internals.
    client_id = fields.StringField(default=lambda: uuid.uuid4().hex,  # Not *guaranteed* unique, but very unlikely
                                   unique=True,
                                   index=True)
    client_secret = fields.StringField(default=generate_client_secret)

    active = fields.BooleanField(default=True,  # Set to False if application is deactivated
                                 index=True)

    owner = fields.ForeignField('User',
                                backref='created',
                                index=True,
                                required=True)

    # User-specified application descriptors
    name = fields.StringField(index=True, required=True)
    description = fields.StringField(required=False)

    date_created = fields.DateTimeField(auto_now_add=datetime.datetime.utcnow,
                                        editable=False)

    home_url = fields.StringField(required=True,
                                  validate=URLValidator())
    callback_url = fields.StringField(required=True,
                                      validate=URLValidator())

    def deactivate(self):
        """
        Deactivate an ApiOAuth2Application

        Does not delete the database record, but revokes all tokens and sets a flag that hides this instance from API
        """
        client = cas.get_client()
        # Will raise a CasHttpError if deletion fails, which will also stop setting of active=False.
        resp = client.revoke_application_tokens(self.client_id, self.client_secret)  # noqa

        self.active = False
        self.save()
        return True

    @property
    def url(self):
        return '/settings/applications/{}/'.format(self.client_id)

    @property
    def absolute_url(self):
        return urlparse.urljoin(settings.DOMAIN, self.url)

    # Properties used by Django and DRF "Links: self" field
    @property
    def absolute_api_v2_url(self):
        return absolute_reverse('applications:application-detail', kwargs={'client_id': self.client_id})

    # used by django and DRF
    def get_absolute_url(self):
        return self.absolute_api_v2_url
