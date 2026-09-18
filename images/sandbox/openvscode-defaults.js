// Loaded by openvscode-server's workbench.html (the Dockerfile links it) before the workbench
// starts: adds Sandbox defaults to the page's web configuration as `configurationDefaults`, so
// they hold from the first paint on (Machine settings arrive from the server after the startup
// editor is decided, which is what shows the Get Started walkthrough). They are defaults: a
// user can still override any of them in the box's settings.
(function () {
  var defaults = {
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    "workbench.tips.enabled": false,
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "files.autoSave": "afterDelay",
    "git.openRepositoryInParentFolders": "always",
    // One agent per Session, the one in the chat: VS Code's own AI surface stays off.
    "chat.disableAIFeatures": true,
    "chat.agent.enabled": false,
    "editor.inlineSuggest.enabled": false,
    "workbench.settings.showAISearchToggle": false,
  };
  var meta = document.getElementById("vscode-workbench-web-configuration");
  if (!meta) return;
  var config = JSON.parse(meta.getAttribute("data-settings") || "{}");
  config.configurationDefaults = Object.assign({}, config.configurationDefaults, defaults);
  meta.setAttribute("data-settings", JSON.stringify(config));
})();
