// This anonymous function exists to isolate generic names inside it to its
// private scope.
(function() {

function ScriptDownloader(win, uri, bundle) {
  this.win_ = win;
  this.uri_ = uri;
  this.bundle_ = bundle;
  this.req_ = null;
  this.script = null;
  this.depQueue_ = [];
  this.dependenciesLoaded_ = false;
  this.installOnCompletion_ = false;
  this.tempFiles_ = [];
}

// Export this one important value to the global namespace.
window.GM_ScriptDownloader=ScriptDownloader;

ScriptDownloader.prototype.startInstall = function() {
  this.installing_ = true;
  this.startDownload();
};

ScriptDownloader.prototype.startViewScript = function(uri) {
  this.installing_ = false;
  this.startDownload();
};

ScriptDownloader.prototype.startDownload = function() {
  this.win_.GM_BrowserUI.statusImage.src = "chrome://global/skin/throbber/Throbber-small.gif";
  this.win_.GM_BrowserUI.statusImage.style.opacity = "0.5";
  this.win_.GM_BrowserUI.statusImage.tooltipText = this.bundle_.getString("tooltip.loading");

  this.win_.GM_BrowserUI.showStatus("Fetching user script", false);

  Components.classes["@greasemonkey.mozdev.org/greasemonkey-service;1"]
    .getService().wrappedJSObject
    .ignoreNextScript();

  this.req_ = new XMLHttpRequest();
  this.req_.open("GET", this.uri_.spec, true);
  this.req_.onload = GM_hitch(this, "handleScriptDownloadComplete");
  this.req_.send(null);
};

ScriptDownloader.prototype.handleScriptDownloadComplete = function() {
  this.win_.GM_BrowserUI.refreshStatus();
  this.win_.GM_BrowserUI.hideStatusImmediately();

  try {
    // If loading from file, status might be zero on success
    if (this.req_.status != 200 && this.req_.status != 0) {
      // NOTE: Unlocalized string
      alert("Error loading user script:\n" +
      this.req_.status + ": " +
      this.req_.statusText);
      return;
    }

    var source = this.req_.responseText;

    this.script = GM_getConfig().parse(source, this.uri_);

    var file = Components.classes["@mozilla.org/file/directory_service;1"]
                         .getService(Components.interfaces.nsIProperties)
                         .get("TmpD", Components.interfaces.nsILocalFile);

    var base = this.script.name.replace(/[^A-Z0-9_]/gi, "").toLowerCase();
    file.append(base + ".user.js");
    file.createUnique(
      Components.interfaces.nsILocalFile.NORMAL_FILE_TYPE,
      0640
    );
    this.tempFiles_.push(file);

    var converter =
      Components.classes["@mozilla.org/intl/scriptableunicodeconverter"]
        .createInstance(Components.interfaces.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    source = converter.ConvertFromUnicode(source);

    var ws = getWriteStream(file);
    ws.write(source, source.length);
    ws.close();

    this.script.setDownloadedFile(file);

    window.setTimeout(GM_hitch(this, "fetchDependencies"), 0);

    if(this.installing_){
      this.showInstallDialog();
    }else{
      this.showScriptView();
    }
  } catch (e) {
    // NOTE: unlocalized string
    alert("Script could not be installed " + e);
    throw e;
  }
};

ScriptDownloader.prototype.fetchDependencies = function(){
  GM_log("Fetching Dependencies");
  var deps = this.script.requires.concat(this.script.resources);
  for (var i = 0; i < deps.length; i++) {
    var dep = deps[i];
    if (this.checkDependencyURL(dep.urlToDownload)) {
      this.depQueue_.push(dep);
    } else {
      this.errorInstallDependency(this.script, dep,
        "SecurityException: Request to local and chrome url's is forbidden");
      return;
    }
  }
  this.downloadNextDependency();
};

ScriptDownloader.prototype.downloadNextDependency = function(){
  if (this.depQueue_.length > 0) {
    var dep = this.depQueue_.pop();
    try {
      var persist = Components.classes[
        "@mozilla.org/embedding/browser/nsWebBrowserPersist;1"]
        .createInstance(Components.interfaces.nsIWebBrowserPersist);
      persist.persistFlags =
        persist.PERSIST_FLAGS_BYPASS_CACHE |
        persist.PERSIST_FLAGS_REPLACE_EXISTING_FILES; //doesn't work?
      var ioservice =
        Components.classes["@mozilla.org/network/io-service;1"]
        .getService(Components.interfaces.nsIIOService);
      var sourceUri = ioservice.newURI(dep.urlToDownload, null, null);
      var sourceChannel = ioservice.newChannelFromURI(sourceUri);
      sourceChannel.notificationCallbacks = new NotificationCallbacks();

      var file = getTempFile();
      this.tempFiles_.push(file);

      var progressListener = new PersistProgressListener(persist);
      progressListener.onFinish = GM_hitch(this,
        "handleDependencyDownloadComplete", dep, file, sourceChannel);
      persist.progressListener = progressListener;

      persist.saveChannel(sourceChannel,  file);
    } catch(e) {
      GM_log("Download exception " + e);
      this.errorInstallDependency(this.script, dep, e);
    }
  } else {
    this.dependenciesLoaded_ = true;
    this.finishInstall();
  }
};

ScriptDownloader.prototype.handleDependencyDownloadComplete =
function(dep, file, channel) {
  GM_log("Dependency Download complete " + dep.urlToDownload);
  try {
    var httpChannel =
      channel.QueryInterface(Components.interfaces.nsIHttpChannel);
  } catch(e) {
    var httpChannel = false;
  }

  if (httpChannel) {
    if (httpChannel.requestSucceeded) {
      dep.setDownloadedFile(file, channel.contentType, channel.contentCharset ? channel.contentCharset : null);
      this.downloadNextDependency();
    } else {
      this.errorInstallDependency(this.script, dep,
        "Error! Server Returned : " + httpChannel.responseStatus + ": " +
        httpChannel.responseStatusText);
    }
  } else {
    dep.setDownloadedFile(file);
    this.downloadNextDependency();
  }
};

ScriptDownloader.prototype.checkDependencyURL = function(url) {
  var ioService = Components.classes["@mozilla.org/network/io-service;1"]
                            .getService(Components.interfaces.nsIIOService);
  var scheme = ioService.extractScheme(url);

  switch (scheme) {
    case "http":
    case "https":
    case "ftp":
        return true;
    case "file":
        var scriptScheme = ioService.extractScheme(this.uri_.spec);
        return (scriptScheme == "file")
    default:
      return false;
  }
};

ScriptDownloader.prototype.finishInstall = function(){
  if (this.installOnCompletion_) {
    this.installScript();
  }
};

ScriptDownloader.prototype.errorInstallDependency = function(script, dep, msg){
  GM_log("Error loading dependency " + dep.urlToDownload + "\n" + msg)
  if (this.installOnCompletion_) {
    alert("Error loading dependency " + dep.urlToDownload + "\n" + msg);
  } else {
    this.dependencyError = "Error loading dependency " + dep.urlToDownload + "\n" + msg;
  }
};

ScriptDownloader.prototype.installScript = function(){
  if (this.dependencyError) {
    alert(this.dependencyError);
  } else if(this.dependenciesLoaded_) {
    this.win_.GM_BrowserUI.installScript(this.script)
  } else {
    this.installOnCompletion_ = true;
  }
};

ScriptDownloader.prototype.cleanupTempFiles = function() {
  for (var i = 0, file = null; file = this.tempFiles_[i]; i++) {
    file.remove(false);
  }
};

ScriptDownloader.prototype.showInstallDialog = function(timer) {
  if (!timer) {
    // otherwise, the status bar stays in the loading state.
    this.win_.setTimeout(GM_hitch(this, "showInstallDialog", true), 0);
    return;
  }
  this.win_.openDialog("chrome://greasemonkey/content/install.xul", "",
                       "chrome,centerscreen,modal,dialog,titlebar,resizable",
                       this);
};

ScriptDownloader.prototype.showScriptView = function() {
  this.win_.GM_BrowserUI.showScriptView(this);
};

function NotificationCallbacks() {}

NotificationCallbacks.prototype.QueryInterface = function(aIID) {
  if (aIID.equals(Components.interfaces.nsIInterfaceRequestor)) {
    return this;
  }
  throw Components.results.NS_NOINTERFACE;
};

NotificationCallbacks.prototype.getInterface = function(aIID) {
  if (aIID.equals(Components.interfaces.nsIAuthPrompt )) {
     var winWat = Components.classes["@mozilla.org/embedcomp/window-watcher;1"]
                            .getService(Components.interfaces.nsIWindowWatcher);
     return winWat.getNewAuthPrompter(winWat.activeWindow);
  }
  return undefined;
};


function PersistProgressListener(persist) {
  this.persist = persist;
  this.onFinish = function(){};
  this.persiststate = "";
}

PersistProgressListener.prototype.QueryInterface = function(aIID) {
 if (aIID.equals(Components.interfaces.nsIWebProgressListener)) {
   return this;
 }
 throw Components.results.NS_NOINTERFACE;
};

// nsIWebProgressListener
PersistProgressListener.prototype.onProgressChange =
  PersistProgressListener.prototype.onLocationChange =
    PersistProgressListener.prototype.onStatusChange =
      PersistProgressListener.prototype.onSecurityChange = function(){};

PersistProgressListener.prototype.onStateChange =
  function(aWebProgress, aRequest, aStateFlags, aStatus) {
    if (this.persist.currentState == this.persist.PERSIST_STATE_FINISHED) {
      GM_log("Persister: Download complete " + aRequest.status);
      this.onFinish();
    }
  };

})();
