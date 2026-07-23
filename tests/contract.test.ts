/**
 * Compile-time contract lock: beacon's envelope MUST be acceptable to the
 * `@absolutejs/errors/ingest` endpoint. This is how we get end-to-end type
 * safety WITHOUT shipping Effect to the browser — the type spans the wire, the
 * runtime does not. If the two shapes drift, `_assignableToIngest` stops
 * typechecking and the build breaks. (@absolutejs/errors is a devDependency
 * only; nothing from it is imported at runtime.)
 */
import { expect, test } from "bun:test";
import type {
  BeaconEnvelope as IngestEnvelope,
  BeaconEvent as IngestEvent,
} from "@absolutejs/errors/ingest";
import {
  BEACON_SIGNAL,
  type BeaconEnvelope,
  type BeaconEvent,
  type BeaconSignal,
} from "../src/index";

// A beacon envelope/event must be assignable to what /ingest accepts.
const _envelopeContract = (envelope: BeaconEnvelope): IngestEnvelope =>
  envelope;
const _eventContract = (event: BeaconEvent): IngestEvent => event;
void _envelopeContract;
void _eventContract;

const fetchFailedSignal: BeaconSignal = BEACON_SIGNAL.FETCH_FAILED;
const signalEvent: BeaconEvent = {
  message: "Network request failed",
  name: "Error",
  tags: { signal: fetchFailedSignal },
};
void signalEvent;

const driftedSignalEvent: BeaconEvent = {
  message: "Network request failed",
  name: "Error",
  // @ts-expect-error Signal names are a public contract; drift must fail typecheck.
  tags: { signal: "failed_request" },
};
void driftedSignalEvent;

test("beacon envelope is contract-locked to /ingest (compile-time)", () => {
  expect(true).toBe(true);
});
