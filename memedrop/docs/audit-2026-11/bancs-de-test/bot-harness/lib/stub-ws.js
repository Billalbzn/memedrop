'use strict';
// Stand-in for the `ws` npm package (not installable here): re-exports the
// ws@8-compatible classes bundled with Playwright, shaped like `ws`'s exports
// (module.exports = WebSocket, with WebSocketServer/Server/WebSocket statics).
const u = require(process.env.HARNESS_UTILS_BUNDLE);
const WebSocket = u.ws;
WebSocket.WebSocket = WebSocket;
WebSocket.WebSocketServer = u.wsServer;
WebSocket.Server = u.wsServer;
if (u.wsReceiver) WebSocket.Receiver = u.wsReceiver;
if (u.wsSender) WebSocket.Sender = u.wsSender;
module.exports = WebSocket;
