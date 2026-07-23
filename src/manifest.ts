import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { BeaconOptions } from "./index";

const MAX_BATCH = 100;
const MAX_BREADCRUMBS = 200;
const MIN_FLUSH_INTERVAL_MS = 250;

/* Serializable, browser-safe subset of BeaconOptions. `key`, `transport`,
 * `beforeSend`, and `getReplayId` are host capabilities and must never be
 * generated from settings. In particular, a browser manifest must not invite
 * an agent to embed an ingest credential. */
export const manifest = defineManifest<BeaconOptions>()({
  contract: 2,
  identity: {
    accent: "#f97316",
    category: "observability",
    description:
      "Tiny browser observability SDK for uncaught errors, rejected promises, breadcrumbs, actionable UX/network signals, Core Web Vitals, trace correlation, and an optional session-replay id. Envelopes are validated by @absolutejs/errors/ingest; no credential belongs in browser settings.",
    docsUrl: "https://github.com/absolutejs/beacon",
    name: "@absolutejs/beacon",
    tagline: "Learn what visitors experience when a site goes wrong.",
  },
  settings: Type.Object({
    endpoint: Type.Optional(
      Type.String({
        default: "/api/errors/ingest",
        description:
          "Same-origin or explicitly allowed error-ingest endpoint. Never put credentials in this URL.",
        title: "Error ingest endpoint",
      }),
    ),
    environment: Type.Optional(
      Type.String({
        description: "Deployment environment attached to each event.",
        examples: ["production"],
        title: "Environment",
      }),
    ),
    flushIntervalMs: Type.Optional(
      Type.Integer({
        description:
          "How often buffered errors are flushed, in milliseconds. Default is 5000.",
        minimum: MIN_FLUSH_INTERVAL_MS,
        title: "Flush interval",
        "x-group": "advanced",
      }),
    ),
    maxBatch: Type.Optional(
      Type.Integer({
        description: "Flush once this many events are buffered. Default is 30.",
        maximum: MAX_BATCH,
        minimum: 1,
        title: "Events per batch",
        "x-group": "advanced",
      }),
    ),
    maxBreadcrumbs: Type.Optional(
      Type.Integer({
        description:
          "Recent browser actions retained with an event. Default is 30.",
        maximum: MAX_BREADCRUMBS,
        minimum: 0,
        title: "Breadcrumb limit",
        "x-group": "advanced",
      }),
    ),
    project: Type.String({
      default: "web",
      description:
        "Project identifier accepted by the host ingest boundary. Managed hosts replace this with their tenant id.",
      title: "Project",
    }),
    release: Type.Optional(
      Type.String({
        description: "Immutable application release identifier.",
        title: "Release",
      }),
    ),
    sampleRate: Type.Optional(
      Type.Number({
        default: 1,
        description: "Fraction of captured events retained, from 0 to 1.",
        maximum: 1,
        minimum: 0,
        title: "Event sample rate",
      }),
    ),
    signals: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Capture dead/rage clicks, failed or slow requests, 5xx responses, and console errors.",
        title: "Actionable browser signals",
      }),
    ),
    vitals: Type.Optional(
      Type.Boolean({
        description:
          "Capture Core Web Vitals through the optional web-vitals peer.",
        title: "Core Web Vitals",
      }),
    ),
  }),
  wiring: [
    {
      description:
        "Initialize privacy-conscious browser error and experience capture. A host can add replay correlation through getReplayId without exposing it as configuration.",
      id: "default",
      client: {
        client: {
          code: "const beacon = initBeacon(${settings});",
          imports: [{ from: "@absolutejs/beacon", names: ["initBeacon"] }],
          placement: "client-entry",
        },
      },
      title: "Capture browser errors and experience signals",
    },
  ],
});
