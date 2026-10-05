// Chat module v2 — adds direct chats and images (jpeg) on top of v1's room text.
//
// The transform itself is every chat version's (../chat-lib/render.ts): the frame's sender
// goes in front of it, and its body passes through. What is v2's own is the frame types it
// draws, and a larger region to stage an image in.
//
// Input:   [pk 32][type u8][body ..]
//   type 3  direct text    body = [to 32][utf-8 text]
//   type 4  direct image   body = [to 32][jpeg bytes]
//   type 5  room text      body = [room 32][utf-8 text]
//   type 6  room image     body = [room 32][jpeg bytes]
//
// Render:  [type u8][pk_len u8][pk ..][body ..]
//
// What a sender is called is not in a frame or a render: a nick is the shell's, and the
// view reads it out of the node's context.
import { frameType, render } from "../chat-lib/render";

const SCRATCH_SIZE: i32 = 0x40000; // 256 KB — input (pk‖type‖body) + render output
const PRIVATE_SIZE: i32 = 0x40000; // 256 KB

export let scratch: i32 = 0;
// Declare the larger I/O region to the host (seedkernel PROTOCOL §4.1) so a big
// image plus its render header is not capped at the 128 KB default.
export const scratchSize: i32 = SCRATCH_SIZE;
let priv: i32 = 0;
scratch = heap.alloc(SCRATCH_SIZE) as i32;
priv = heap.alloc(PRIVATE_SIZE) as i32;

export function handle(input_len: i32): i32 {
  const type = frameType(scratch, input_len);
  if (type < 3 || type > 6) return 0;
  return render(scratch, priv, PRIVATE_SIZE, input_len);
}
