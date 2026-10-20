import type { ApiPorts } from "tg-api/actions";
import type { LambdaInvoker } from "tg-aws/lambda";
import { manualClock } from "./clock";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "./db";
import { FakeCategoryLogReader, FakeMetricReader, FakeQueueDepthReader } from "./observability";
import { FakeDlqInspector, FakeDlqPurger, fakeQueueProducer } from "./queues";

const QUEUES = { analyze: "q/analyze", aggregate: "q/aggregate", publish: "q/publish" };
const DLQS = { analyze: "dlq/analyze", aggregate: "dlq/aggregate", publish: "dlq/publish" };

/** Every port `tg-api` reaches, in memory. A Lambda invoke answers `reply`. */
export function fakeApiPorts(reply: unknown = {}): ApiPorts & {
  readonly invocations: { functionName: string; payload: unknown }[];
} {
  const invocations: { functionName: string; payload: unknown }[] = [];
  const lambda: LambdaInvoker = {
    invoke: async (functionName, payload) => {
      invocations.push({ functionName, payload });
      return reply;
    },
  };

  return {
    invocations,
    sources: fakeSourceRepo(),
    messages: fakeMessageRepo(),
    targets: fakeTargetRepo(),
    clock: manualClock(1_770_000_000_000),
    lambda,
    functions: {
      scrape: "telegator-scrape",
      dlqReplay: "telegator-dlq-replay",
      publish: "telegator-publish",
      consume: "telegator-consume",
    },
    publishQueue: fakeQueueProducer(),
    metrics: new FakeMetricReader(),
    logs: new FakeCategoryLogReader(),
    queues: new FakeQueueDepthReader(),
    queueUrls: QUEUES,
    dlqUrls: DLQS,
    inspector: new FakeDlqInspector(),
    purger: new FakeDlqPurger(),
  };
}
