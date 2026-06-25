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
import type { BeaconEnvelope, BeaconEvent } from "../src/index";

// A beacon envelope/event must be assignable to what /ingest accepts.
const _envelopeContract = (envelope: BeaconEnvelope): IngestEnvelope =>
  envelope;
const _eventContract = (event: BeaconEvent): IngestEvent => event;
void _envelopeContract;
void _eventContract;

test("beacon envelope is contract-locked to /ingest (compile-time)", () => {
  expect(true).toBe(true);
});
