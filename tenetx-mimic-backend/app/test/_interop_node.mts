// Real cross-language interop harness for task 6 (relayState + statusToken port).
//
// This is NOT a Python-side re-implementation of the Node algorithm — it imports
// and runs the ACTUAL product code:
//   ../../../tenetx-mimic-backend/src/relayState.ts   (encodeRelayState/decodeRelayState)
//   ../../../tenetx-mimic-backend/src/statusToken.ts   (signStatus/verifyStatus)
// so the Python test can prove BYTE-compatibility against the genuine Node
// implementation, not a paraphrase of it.
//
// Invoked by app/test/test_relay_state.py + test_status_token.py via
// `node --import tsx _interop_node.mts <mode>`. Output is wrapped in unique
// markers so the caller can extract the JSON even if anything else writes to
// stdout.
//
// Modes (argv[2]):
//   vectors     — emit Node-produced encode/decode/sign vectors (Node -> Python).
//   verify      — read INTEROP_SECRET + INTEROP_TOKEN (+ optional INTEROP_NOW_MS),
//                 print { result: verifyStatus(token) } (Python -> Node).
//   relaydecode — read INTEROP_RELAY, print { result: decodeRelayState(raw) }
//                 (Python-encoded relay -> Node decoder).
//
// statusToken.ts reads MIMIC_STATUS_SECRET ONCE at module-load, so every mode
// sets the env var BEFORE the dynamic import (mirrors statusToken.test.ts).

const FIXED_SECRET = "interop-secret-\u00e9-\u4e2d"; // non-ASCII: proves UTF-8 HMAC-key handling
const FIXED_IAT = 1700000000000; // pinned so signStatus stamps a deterministic iat

const START = "<<INTEROP_JSON>>";
const END = "<<END_INTEROP_JSON>>";

function out(obj: unknown): void {
  process.stdout.write(START + JSON.stringify(obj) + END);
}

const relayModule = "../../../tenetx-mimic-backend/src/relayState.ts";
const statusModule = "../../../tenetx-mimic-backend/src/statusToken.ts";

const mode = process.argv[2];

if (mode === "vectors") {
  process.env.MIMIC_STATUS_SECRET = FIXED_SECRET;
  const { encodeRelayState, decodeRelayState } = await import(relayModule);
  const { signStatus } = await import(statusModule);

  const relayEncodeInputs: Array<{ returnUrl: string; connectionDocId?: string }> = [
    { returnUrl: "https://x/y" },
    { returnUrl: "https://x/y", connectionDocId: "" },
    { returnUrl: "https://x/y", connectionDocId: "abc123" },
    {
      returnUrl: "https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out",
      connectionDocId: "doc-\u00e9-\u4e2d",
    },
  ];
  const relayEncode = relayEncodeInputs.map((input) => ({
    input,
    output: encodeRelayState(input),
  }));

  const relayDecodeInputs: string[] = [
    encodeRelayState({ returnUrl: "https://x/y", connectionDocId: "abc123" }),
    "https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out",
    "mimicrs:garbage-not-base64!!!",
  ];
  const relayDecode = relayDecodeInputs.map((input) => ({
    input,
    output: decodeRelayState(input),
  }));

  // Byte-identity vector: pin Date.now so the stamped iat is deterministic, then
  // the Python signer (with its clock + secret pinned to the same values) must
  // produce a byte-identical token string.
  const realNow = Date.now;
  Date.now = () => FIXED_IAT;
  const signPayload: Record<string, unknown> = {
    status: "validated",
    email: "a@b.com",
    reason: null,
    note: "h\u00e9llo-\u4e2d", // non-ASCII value: proves ensure_ascii=False parity
  };
  const signToken = signStatus(signPayload);
  Date.now = realNow;

  out({
    fixedSecret: FIXED_SECRET,
    fixedIat: FIXED_IAT,
    relayEncode,
    relayDecode,
    signPayload,
    signToken,
  });
} else if (mode === "verify") {
  const secret = process.env.INTEROP_SECRET ?? "";
  const token = process.env.INTEROP_TOKEN ?? "";
  const nowMs = process.env.INTEROP_NOW_MS;
  process.env.MIMIC_STATUS_SECRET = secret;
  const { verifyStatus } = await import(statusModule);
  if (nowMs) {
    const fixed = Number(nowMs);
    Date.now = () => fixed; // keep the Python-signed token inside the 5-min window
  }
  out({ result: verifyStatus(token) });
} else if (mode === "relaydecode") {
  const raw = process.env.INTEROP_RELAY ?? "";
  const { decodeRelayState } = await import(relayModule);
  out({ result: decodeRelayState(raw) });
} else {
  process.stderr.write(`unknown mode: ${String(mode)}\n`);
  process.exit(2);
}
