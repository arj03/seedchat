// Chat v1's guest: room text, and nothing else. What a chat guest does with a frame is the
// chat guest library's (../chat-lib/chat-guest.js `serve`); what is v1's own is the one
// frame type it speaks, so it stays silent on every other frame a later version sends.
async function handle(arg) {
  return await serve(arg, [ROOM_TEXT]);
}
