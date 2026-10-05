// Chat module v1 — text only, written to a room.
//
// The transform itself is every chat version's (../chat-lib/render.ts): the frame's sender
// goes in front of it, and its body passes through. What is v1's own is that it draws one
// frame type, and how much memory it stages one in.
//
// Input:   [pk 32][type u8][body ..]   type = 0x05 (room text), body = [room 32][utf-8 text]
// Render:  [type u8][pk_len u8][pk ..][body ..]
import { frameType, render } from "../chat-lib/render";

const SCRATCH_SIZE: i32 = 0x20000; // 128 KB
const PRIVATE_SIZE: i32 = 0x20000; // 128 KB

export let scratch: i32 = 0;
let priv: i32 = 0;
scratch = heap.alloc(SCRATCH_SIZE) as i32;
priv = heap.alloc(PRIVATE_SIZE) as i32;

export function handle(input_len: i32): i32 {
  if (frameType(scratch, input_len) != 5) return 0;    // v1 only knows room text
  return render(scratch, priv, PRIVATE_SIZE, input_len);
}
