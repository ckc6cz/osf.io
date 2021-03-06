<%inherit file="notify_base.mako" />


<%def name="content()">
<tr>
  <td style="border-collapse: collapse;">
  <% from website import settings %>
  <h3 class="text-center" style="padding: 0;margin: 30px 0 0 0;border: none;list-style: none;font-weight: 300;text-align: center;">Issue registering <a href="${settings.DOMAIN.rstrip('/')+ src.url}">${src.title}</a></h3>
  </td>
</tr>
<tr>
  <td style="border-collapse: collapse;">
    We cannot archive ${src.title} at this time because there were errors copying files from some of the linked third-party services. It's possible that this is due to temporary unavailability of one or more of these services and that retrying the registration may resolve this issue. Our development team is investigating this failure. We're sorry for any inconvienence this may have caused.
  </td>
</tr>
</%def>
