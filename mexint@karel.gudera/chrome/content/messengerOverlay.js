const { require } = Components.utils.import('resource://gre/modules/commonjs/toolkit/require.js', {});
const subprocess = require('sdk/system/child_process/subprocess');
const base64 = require('sdk/base64');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

var OS = Components.classes["@mozilla.org/xre/app-info;1"]
         .getService(Components.interfaces.nsIXULRuntime).OS;
var node = (OS == "WINNT") ? "node.exe" : "node";
var nodePath = FileUtils.getFile("ProfD", ["extensions", "mexint@karel.gudera", "components", node]);
var getMsgPath = FileUtils.getFile("ProfD", ["extensions", "mexint@karel.gudera", "server", "get_messages.js"]);
var getHdrPath = FileUtils.getFile("ProfD", ["extensions", "mexint@karel.gudera", "server", "get_headers.js"]);

function showNotification (notificationMessage)
{
	let gActivityManager = Components.classes["@mozilla.org/activity-manager;1"]
	                       .getService(Components.interfaces.nsIActivityManager);                       
	let event = Components.classes["@mozilla.org/activity-event;1"]
	            .createInstance(Components.interfaces.nsIActivityEvent);

	event.init(notificationMessage,
               null, 
               "", 
               Date.now(),
               Date.now());
	             
	gActivityManager.addActivity(event);
	gActivityManager.removeActivity(event.id);
}

function saveMessage (message_base64, server)
{
	var inbox = server.rootFolder.getFolderWithFlags(Components.interfaces.nsMsgFolderFlags.Inbox);
	var messageSource = atob(message_base64);
	inbox.QueryInterface(Components.interfaces.nsIMsgLocalMailFolder);
	inbox.addMessage(messageSource);
}

function fetchMessages (IDs, server, URL, username, password, authType, TLS)
{
	var exitCode;
	var stdout = "";
	var stderr;
	var msgCnt = 0;
	var IDsStr = "";

	for ( var i = 0; i < IDs.length; i++ )
		(i == IDs.length - 1) ? IDsStr += IDs[i] : IDsStr += IDs[i] + '\n';

	let authData_base64 = base64.encode(URL      + '\n' +
		                                username + '\n' + 
		                                password + '\n' +
		                                authType + '\n' +
		                                TLS,
		                                "utf-8");

	let IDs_base64 = base64.encode(IDsStr, "utf-8");

	var p = subprocess.call({
		command: nodePath.path,
		arguments: [getMsgPath.path],
		//environment: [],
		charset: "UTF-8",
		//workdir: "",

		stdin: function (stdin) {
			stdin.write(authData_base64 + '\n' + IDs_base64);
			stdin.close();
		},

		stdout: function (data) {
			stdout += data;
			var lfIndex = stdout.indexOf('\n');

			if ( lfIndex > -1 )
			{
				showNotification(server.prettyName + ": Downloading message " + (++msgCnt) + " of " + IDs.length + "...");
				var message = stdout.slice(0, lfIndex);
				stdout = stdout.slice(lfIndex + 1);
				saveMessage(message, server);
			}
		},

		done: function (result) {
			exitCode = result.exitCode;
			stderr = result.stderr;
			running = false;
			showNotification(server.prettyName + ": Received " + IDs.length + " of " + IDs.length + " message(s)");
		},

		mergeStderr: false
	});
}

function deleteMessages (msgDBHdrs, folder)
{
	Components.utils.import("resource:///modules/iteratorUtils.jsm");
	let xpcomHdrArray = toXPCOMArray(msgDBHdrs, Components.interfaces.nsIMutableArray);
	folder.deleteMessages(xpcomHdrArray, null, true, false, null, false);
}

function parseHeaders (headers, server, URL, username, password, authType, TLS)
{
	var headers = headers.split('\n');
	headers.pop(); // last '\n' causes extra empty string
	var serverHeaders = [];
	var localHeaders = [];
	var localMsgDBHdrs = [];
	var inbox = server.rootFolder.getFolderWithFlags(Components.interfaces.nsMsgFolderFlags.Inbox);

	Components.utils.import("resource:///modules/iteratorUtils.jsm");

	// server headers
	for (let i = 0; i < headers.length; i++)
	{
		serverHeaders.push(headers[i]);
	}

	// local headers
	for (let msgHdr in fixIterator(inbox.messages, Components.interfaces.nsIMsgDBHdr)) 
	{
		localHeaders.push(msgHdr.messageId);
		localMsgDBHdrs.push(msgHdr);
	}

	var serverHdrNum = serverHeaders.length;
	var localHdrNum = localHeaders.length;
	var toFetch = [];
	var toDelete = [];

	for (let i = 0; i < serverHdrNum; i++)
	{
		if ( ! (localHeaders.indexOf(serverHeaders[i]) > -1) ) // hdr not yet in mailbox => fetch it
			toFetch.push(serverHeaders[i]);
	}

	for (let i = 0; i < localHdrNum; i++)
	{
		if ( ! (serverHeaders.indexOf(localHeaders[i]) > -1) ) // local hdr not in server headers => delete it
			toDelete.push(localMsgDBHdrs[i]);
	}

	if ( toDelete.length > 0 )
	{
		deleteMessages(toDelete, inbox);
	}

	if ( toFetch.length > 0 )
	{
		showNotification(server.prettyName + ": Found " + toFetch.length + " message(s) to download");
		fetchMessages(toFetch, server, URL, username, password, authType, TLS);
	}
	else
	{
		running = false;
		showNotification(server.prettyName + ": No messages to download");
	}
}

function getHeaders (server, URL, username, password, authType, TLS)
{
	var exitCode;
	var stdout;
	var stderr;

	let authData_base64 = base64.encode(URL      + '\n' +
		                                username + '\n' + 
		                                password + '\n' +
		                                authType + '\n' +
		                                TLS,
		                                "utf-8");

	var p = subprocess.call({
		command: nodePath.path,
		arguments: [getHdrPath.path],
		//environment: [],
		charset: "UTF-8",
		//workdir: "",

		stdin: function (stdin) {
			stdin.write(authData_base64);
			stdin.close();
		},

		done: function (result) {
			exitCode = result.exitCode;
			stdout = result.stdout;
			stderr = result.stderr;

			if ( stdout == "ERROR" )
			{
				running = false;
				showNotification(server.prettyName + ": Error connecting to Exchange server");
				return;
			}

			parseHeaders(stdout, server, URL, username, password, authType, TLS);
		},

		mergeStderr: false
	});
}

function getMessages (server)
{
	var URL = server.getCharValue("ewsURL");
	var username = server.username;
	var password;
	var authType = server.getCharValue("authType");
	var TLS = server.getCharValue("TLS");

	var passwordManager = Components.classes["@mozilla.org/login-manager;1"]
                          .getService(Components.interfaces.nsILoginManager);

    var nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
    	                                         Components.interfaces.nsILoginInfo,
    	                                         "init");

    var logins = passwordManager.findLogins({}, 'chrome://mexint', null, 'User Registration');
      
	for ( var i = 0; i < logins.length; i++ )
	{
		if ( logins[i].username == username )
		{
			password = logins[i].password;
			break;
		}
	}

	showNotification(server.prettyName + ": Checking for new messages...");
	getHeaders(server, URL, username, password, authType, TLS);
}

function mexint_onLoad (event)
{
	window.running = false;

	// override original function
	GetNewMsgs = function (server, folder)
	{
		// START MY CODE
		if ( server.getBoolValue("mexint") )
		{
			if ( running )
				return;

			running = true;
			getMessages(server);

			return;
		}
		// END MY CODE

		// Note that for Global Inbox folder.server != server when we want to get
		// messages for a specific account.

		const nsIMsgFolder = Components.interfaces.nsIMsgFolder;
		// Whenever we do get new messages, clear the old new messages.
		folder.biffState = nsIMsgFolder.nsMsgBiffState_NoMail;
		folder.clearNewMessages();
		server.getNewMessages(folder, msgWindow, null);
	}

	// override original function
	GetMessagesForAllAuthenticatedAccounts = function ()
	{
	  // now log into any server
	  try
	  {
	    var allServers = accountManager.allServers;
	    // array of isupportsarrays of servers for a particular folder
	    var pop3DownloadServersArray = [];
	    // parallel array of folders to download to...
	    var localFoldersToDownloadTo = [];
	    var pop3Server;

	    for (var i = 0; i < allServers.length; ++i)
	    {
	      var currentServer = allServers.queryElementAt(i, Components.interfaces.nsIMsgIncomingServer);

	      // START MY CODE
	      if ( currentServer.getBoolValue("mexint") )
	      {
	        if ( running )
	          continue;

	        running = true;
	        getMessages(currentServer);

	        continue;
	      }
	      // END MY CODE

	      if (currentServer.protocolInfo.canGetMessages &&
	          !currentServer.passwordPromptRequired)
	      {
	        if (currentServer.type == "pop3")
	        {
	          CoalesceGetMsgsForPop3ServersByDestFolder(currentServer,
	            pop3DownloadServersArray, localFoldersToDownloadTo);
	          pop3Server = currentServer.QueryInterface(Components.interfaces.nsIPop3IncomingServer);
	        }
	        else
	        // get new messages on the server for imap or rss
	          GetMessagesForInboxOnServer(currentServer);
	      }
	    }
	    for (var i = 0; i < pop3DownloadServersArray.length; ++i)
	    {
	      // any ol' pop3Server will do - the serversArray specifies which servers to download from
	      pop3Server.downloadMailFromServers(pop3DownloadServersArray[i],
	                                         pop3DownloadServersArray[i].length,
	                                         msgWindow,
	                                         localFoldersToDownloadTo[i],
	                                         null);
	    }
	  }
	  catch(ex)
	  {
	      dump(ex + "\n");
	  }
	}
}

window.addEventListener("load", function (event) { mexint_onLoad(event); }, false);