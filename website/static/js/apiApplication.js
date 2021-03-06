/*
 *  Knockout views for the Developer application pages: List and Create/Edit pages.
 */


'use strict';

var $ = require('jquery');
var bootbox = require('bootbox');
var historyjs = require('exports?History!history');

var ko = require('knockout');
require('knockout.validation');
var Raven = require('raven-js');

var ChangeMessageMixin = require('js/changeMessage');
var koHelpers = require('./koHelpers');  // URL validators etc
var $osf = require('./osfHelpers');
var oop = require('js/oop');
var language = require('js/osfLanguage');

/*
 *  Store the data related to a single API application
 */
var ApplicationData = oop.defclass({
    constructor: function (data) {  // Read in API data and store as object
        data = data || {};

        // User-editable fields
        this.name = ko.observable(data.name)
            .extend({required: true});
        this.description = ko.observable(data.description);
        this.homeUrl = ko.observable(data.home_url)
            .extend({
                url: true,
                ensureHttp: true,
                required: true
            });
        this.callbackUrl = ko.observable(data.callback_url)
            .extend({
                url: true,
                ensureHttp: true,
                required: true
            });

        // Other fields. Owner and client ID should never change within this view.
        this.owner = data.owner;
        this.clientId = data.client_id;
        this.clientSecret = ko.observable(data.client_secret);
        this.webDetailUrl = data.links ? data.links.html : undefined;
        this.apiDetailUrl = data.links ? data.links.self : undefined;

        // Enable value validation in form
        this.validated =  ko.validatedObservable(this);

        this.isValid = ko.computed(function () {
            return this.validated.isValid();
        }.bind(this));
    },

    serialize: function () {
        return { // Convert data to JSON-serializable format consistent with API
            name: this.name(),
            description: this.description(),
            home_url: this.homeUrl(),
            callback_url: this.callbackUrl(),
            client_id: this.clientId,
            client_secret: this.clientSecret(),
            owner: this.owner
        };
    }
});

/*
 * Fetch data about applications
 */
var ApplicationDataClient = oop.defclass({
    /*
     * Create the client for server operations on ApplicationData objects.
     * @param {Object} apiListUrl: The api URL for application listing/creation
     */
    constructor: function (apiListUrl) {
        this.apiListUrl = apiListUrl;
    },
    _fetchData: function (url) {
        var ret = $.Deferred();
        var request = $osf.ajaxJSON('GET', url, {isCors: true});

        request.done(function (data) {
            ret.resolve(this.unserialize(data));
        }.bind(this));

        request.fail(function (xhr, status, error) {
            ret.reject(xhr, status, error);
        }.bind(this));

        return ret.promise();
    },
    fetchList: function () {
        return this._fetchData(this.apiListUrl);
    },
    fetchOne: function (url) {
        return this._fetchData(url);
    },
    _sendData: function (appData, url, method) {
        var ret = $.Deferred();

        var payload = appData.serialize();
        var request = $osf.ajaxJSON(method, url, {isCors: true, data: payload});

        request.done(function (data) { // The server response will contain the newly created/updated record
            ret.resolve(this.unserialize(data));
        }.bind(this));
        request.fail(function (xhr, status, error) {
            ret.reject(xhr, status, error);
        });
        return ret.promise();
    },
    createOne: function (appData) {
        var url = this.apiListUrl;
        return this._sendData(appData, url, 'POST');
    },
    updateOne: function (appData) {
        var url = appData.apiDetailUrl;
        return this._sendData(appData, url, 'PATCH');
    },
    deleteOne: function (appData) {
        var url = appData.apiDetailUrl;
        return $osf.ajaxJSON('DELETE', url, {isCors: true});
    },
    unserialize: function (apiData) {
        var result;
        // Check return type: return one object (detail view) or list of objects (list view) as appropriate.
        if (Array.isArray(apiData.data)) {
            result = $.map(apiData.data, function (item) {
                return new ApplicationData(item);
            });
        } else if (apiData.data) {
            result = new ApplicationData(apiData.data);
        } else {
            result = null;
        }
        return result;
    }
});

/*
  ViewModel for List views
 */
var ApplicationsListViewModel = oop.defclass({
    constructor: function (urls) {
        this.apiListUrl = urls.apiListUrl;
        this.webCreateUrl = urls.webCreateUrl;
        // Set up data storage
        this.appData = ko.observableArray();
        this.sortedByName = ko.pureComputed(function () {
            return this.appData().sort(function (a,b) {
                var an = a.name().toLowerCase();
                var bn = b.name().toLowerCase();
                return an === bn ? 0 : (an < bn ? -1 : 1);
            });
        }.bind(this));

        // Set up data access client
        this.client = new ApplicationDataClient(this.apiListUrl);
    },
    init: function () {
        var request = this.client.fetchList();
        request.done(function (data) {
            this.appData(data);
        }.bind(this));

        request.fail(function(xhr, status, error) {
            $osf.growl('Error',
                language.apiOauth2Application.dataListFetchError,
                'danger');

            Raven.captureMessage('Error fetching list of registered applications', {
                url: this.apiListUrl,
                status: status,
                error: error
            });
        }.bind(this));
    },
    deleteApplication: function (appData) {
        bootbox.confirm({
            title: 'Deactivate application?',
            message: language.apiOauth2Application.deactivateConfirm,
            callback: function (confirmed) {
                if (confirmed) {
                    var request = this.client.deleteOne(appData);
                    request.done(function () {
                            this.appData.destroy(appData);
                            var appName = $osf.htmlEscape(appData.name());
                            $osf.growl('Deletion', '"' + appName + '" has been deactivated', 'success');
                    }.bind(this));
                    request.fail(function () {
                            $osf.growl('Error',
                                       language.apiOauth2Application.deactivateError,
                                       'danger');
                    }.bind(this));
                }
            }.bind(this),
            buttons:{
                confirm:{
                    label:'Deactivate',
                    className:'btn-danger'
                }
            }
        });
    }
});


/*
  ViewModel for Detail views (create and update pages- related though distinct behaviors in a single ViewModel)
    Expects a urls object containing webListUrl, apiListUrl, and apiDetailUrl values. If apiDetailUrl is blank, it
    behaves like a create view.
 */
var ApplicationDetailViewModel = oop.extend(ChangeMessageMixin, {
    constructor: function (urls) {
        this.super.constructor.call(this);
        var placeholder = new ApplicationData();
        this.appData = ko.observable(placeholder);

        // Track whether data has changed, and whether user is allowed to leave page anyway
        this.originalValues = ko.observable(placeholder.serialize());
        this.dirty = ko.computed(function(){
            return JSON.stringify(this.originalValues()) !== JSON.stringify(this.appData().serialize());
        }.bind(this));
        this.allowExit = ko.observable(false);

        // Set up data access client
        this.webListUrl = urls.webListUrl;
        this.client = new ApplicationDataClient(urls.apiListUrl);

        // Toggle hiding client secret (in detail view)
        this.showSecret = ko.observable(false);
        // Toggle display of validation messages
        this.showMessages = ko.observable(false);

        // // If no detail url provided, render view as though it was a creation form. Otherwise, treat as READ/UPDATE.
        this.apiDetailUrl = ko.observable(urls.apiDetailUrl);
        this.isCreateView = ko.computed(function () {
            return !this.apiDetailUrl();
        }.bind(this));
    },
    init: function () {
        if (!this.isCreateView()) {
            // Add listener to prevent user from leaving page if there are unsaved changes
            $(window).on('beforeunload', function () {
                if (this.dirty() && !this.allowExit()) {
                    return 'There are unsaved changes on this page.';
                }
            }.bind(this));

            var request = this.client.fetchOne(this.apiDetailUrl());
            request.done(function (dataObj) {
                this.appData(dataObj);
                this.originalValues(dataObj.serialize());
            }.bind(this));
            request.fail(function(xhr, status, error) {
                $osf.growl('Error',
                             language.apiOauth2Application.dataFetchError,
                            'danger');

                Raven.captureMessage('Error fetching application data', {
                    url: this.apiDetailUrl(),
                    status: status,
                    error: error
                });
            }.bind(this));
        }
    },
    updateApplication: function () {
        if (!this.dirty()){
            // No data needs to be sent to the server, but give the illusion that form was submitted
            this.changeMessage(
                language.apiOauth2Application.dataUpdated,
                'text-success',
                5000);
            return;
        }

        var request = this.client.updateOne(this.appData());
        request.done(function (dataObj) {
            this.appData(dataObj);
            this.originalValues(dataObj.serialize());
            this.changeMessage(
                language.apiOauth2Application.dataUpdated,
                'text-success',
                5000);
        }.bind(this));

        request.fail(function (xhr, status, error) {
            $osf.growl('Error',
                       language.apiOauth2Application.dataSendError,
                       'danger');

            Raven.captureMessage('Error updating instance', {
                url: this.apiDetailUrl,
                status: status,
                error: error
            });
        }.bind(this));
        return request;
    },
    createApplication: function () {
        var request = this.client.createOne(this.appData());
        request.done(function (dataObj) {
            this.appData(dataObj);
            this.originalValues(dataObj.serialize());

            this.changeMessage(language.apiOauth2Application.creationSuccess, 'text-success', 5000);
            this.apiDetailUrl(dataObj.apiDetailUrl); // Toggle ViewModel --> act like a display view now.
            historyjs.replaceState({}, '', dataObj.webDetailUrl);  // Update address bar to show new detail page
        }.bind(this));

        request.fail(function (xhr, status, error) {
            $osf.growl('Error',
                       language.apiOauth2Application.dataSendError,
                       'danger');

            Raven.captureMessage('Error registering new OAuth2 application', {
                url: this.apiDetailUrl,
                status: status,
                error: error
            });
        }.bind(this));
    },
    submit: function () {
        // Validate and dispatch form to correct handler based on view type
        if (!this.appData().isValid()) {
            // Turn on display of validation messages
            this.showMessages(true);
        } else {
            this.showMessages(false);
            if (this.isCreateView()) {
                this.createApplication();
            } else {
                this.updateApplication();
            }
        }
    },
    deleteApplication: function () {
        var appData = this.appData();
        bootbox.confirm({
            title: 'Deactivate application?',
            message: language.apiOauth2Application.deactivateConfirm,
            callback: function (confirmed) {
                if (confirmed) {
                    var request = this.client.deleteOne(appData );
                    request.done(function () {
                        this.allowExit(true);
                        // Don't let user go back to a deleted application page
                        historyjs.replaceState({}, '', this.webListUrl);
                        this.visitList();
                    }.bind(this));
                    request.fail(function () {
                            $osf.growl('Error',
                                       language.apiOauth2Application.deactivateError,
                                       'danger');
                    }.bind(this));
                }
            }.bind(this),
            buttons:{
                confirm:{
                    label:'Deactivate',
                    className:'btn-danger'
                }
            }
        });
    },
    visitList: function () {
        window.location = this.webListUrl;
    },
    cancelChange: function () {
        if (!this.dirty()) {
            this.visitList();
        } else {
            bootbox.confirm({
                title: 'Discard changes?',
                message: language.apiOauth2Application.discardUnchanged,
                callback: function(confirmed) {
                    if (confirmed) {
                        this.allowExit(true);
                        this.visitList();
                    }
                }.bind(this),
                buttons: {
                    confirm: {
                        label:'Discard',
                        className:'btn-danger'
                    }
                }
            });
        }
    },
    toggleDisplay: function () {
        // Toggle display of client secret on detail view page
        this.showSecret(!this.showSecret());
    }
});


var ApplicationsList = function (selector, urls) {
    this.viewModel = new ApplicationsListViewModel(urls);
    $osf.applyBindings(this.viewModel, selector);
    this.viewModel.init();
};

var ApplicationDetail = function (selector, urls) {
    this.viewModel = new ApplicationDetailViewModel(urls);
    $osf.applyBindings(this.viewModel, selector);
    this.viewModel.init();
};

module.exports = {
    ApplicationsList: ApplicationsList,
    ApplicationDetail: ApplicationDetail,
    // Make internals accessible directly for testing
    _ApplicationData: ApplicationData,
    _ApplicationDataClient: ApplicationDataClient,
    _ApplicationsListViewModel: ApplicationsListViewModel,
    _ApplicationDetailViewModel: ApplicationDetailViewModel
};
