import { encode } from "gpt-tokenizer";

/** Package-root encoder semantics, bundled into the offline desktop artifact. */
export function encodeTokenCount(text: string): number {
  return encode(text).length;
}