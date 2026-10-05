// Chat v2's guest: rooms and direct chats, text and images. What a chat guest does with a
// frame is the chat guest library's (../chat-lib/chat-guest.js `serve`); what is v2's own
// is the frame types it speaks, which are all of them.
async function handle(arg) {
  return await serve(arg, [ROOM_TEXT, ROOM_IMAGE, DIRECT_TEXT, DIRECT_IMAGE]);
}
