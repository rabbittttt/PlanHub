using System;
using System.Collections.Specialized;
using System.Configuration;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web;
using System.Web.Script.Serialization;

namespace PlanHub
{
    // No business endpoint list: identity applies to the entire IIS application.
    public sealed class TrustedIdentityBridge : IHttpModule
    {
        private const string ItemKey = "PlanHub.TrustedIdentityBridge.Config";
        public sealed class BridgeConfig
        {
            public int SchemaVersion { get; set; }
            public string AppId { get; set; }
            public string UserHeader { get; set; }
            public string KeyHeader { get; set; }
            public string ProxySecretPath { get; set; }
        }
        public static void ValidateConfiguration(BridgeConfig config, string appId)
        {
            if (config == null || config.SchemaVersion != 1 ||
                !Regex.IsMatch(appId ?? "", "^[a-z][a-z0-9-]{0,39}$") || config.AppId != appId ||
                !ValidHeader(config.UserHeader) || !ValidHeader(config.KeyHeader) ||
                String.Equals(config.UserHeader, config.KeyHeader, StringComparison.OrdinalIgnoreCase) ||
                String.IsNullOrWhiteSpace(config.ProxySecretPath) || !Path.IsPathRooted(config.ProxySecretPath))
                throw new ConfigurationErrorsException("Invalid identity configuration.");
        }
        private static bool ValidHeader(string name)
        {
            return name != null && name.Length <= 80 && Regex.IsMatch(name, "^X-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$") &&
                !name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase) && !name.StartsWith("X-Original-", StringComparison.OrdinalIgnoreCase);
        }
        public static void StripIdentityHeaders(NameValueCollection headers, BridgeConfig config)
        {
            headers.Remove(config.UserHeader);
            headers.Remove(config.KeyHeader);
        }
        public static string GetWindowsUser(IIdentity principalIdentity)
        {
            WindowsIdentity identity = principalIdentity as WindowsIdentity;
            if (identity == null || !identity.IsAuthenticated || identity.IsAnonymous || String.IsNullOrWhiteSpace(identity.Name))
                throw new HttpException(401, "Windows authentication is required.");
            // The application's existing raw header contract is ASCII. Never send a corrupted account name.
            if (identity.Name.Length > 200 || !Regex.IsMatch(identity.Name, "^[\\x20-\\x7e]+$"))
                throw new HttpException(403, "The Windows account identifier cannot be represented by this application's raw header contract.");
            return identity.Name;
        }
        public void Init(HttpApplication app)
        {
            app.BeginRequest += StripClientIdentity;
            app.PostAuthenticateRequest += StampWindowsIdentity;
        }
        private static void Deny(HttpContext context, int code)
        {
            context.Items[ItemKey] = null;
            context.Response.StatusCode = code;
            context.Response.TrySkipIisCustomErrors = true;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.Cache.SetCacheability(HttpCacheability.NoCache);
            context.Response.Write("{\"error\":\"Trusted Windows identity is unavailable. Contact the administrator.\"}");
            context.ApplicationInstance.CompleteRequest();
        }
        private static void StripClientIdentity(object sender, EventArgs e)
        {
            HttpContext context = ((HttpApplication)sender).Context;
            try
            {
                string path = ConfigurationManager.AppSettings["PlanHubIdentityConfigPath"];
                if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)) throw new ConfigurationErrorsException();
                BridgeConfig config = new JavaScriptSerializer().Deserialize<BridgeConfig>(File.ReadAllText(path, Encoding.UTF8));
                ValidateConfiguration(config, ConfigurationManager.AppSettings["PlanHubIdentityAppId"]);
                // Remove all client values before Windows authentication, including duplicate headers.
                StripIdentityHeaders(context.Request.Headers, config);
                context.Items[ItemKey] = config;
            }
            catch { Deny(context, 503); }
        }
        private static void StampWindowsIdentity(object sender, EventArgs e)
        {
            HttpContext context = ((HttpApplication)sender).Context;
            BridgeConfig config = context.Items[ItemKey] as BridgeConfig;
            if (config == null) return;
            try
            {
                string user = GetWindowsUser(context.User == null ? null : context.User.Identity);
                string secret = File.ReadAllText(config.ProxySecretPath, Encoding.UTF8).Trim();
                if (!Regex.IsMatch(secret, "^[A-Za-z0-9_-]{32,256}$")) throw new ConfigurationErrorsException();
                context.Request.Headers.Set(config.UserHeader, user);
                context.Request.Headers.Set(config.KeyHeader, secret);
            }
            catch (HttpException error) { Deny(context, error.GetHttpCode()); }
            catch { Deny(context, 503); }
        }
        public void Dispose() { }
    }
}
