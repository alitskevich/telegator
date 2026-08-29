import {
  MessageSystemAttributeName,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";

/**
 * §8.2 L723 — "Queue depths + DLQ inspection/replay".
 *
 * Depths come from `GetQueueAttributes` (`lib/aws/observability.ts`); this is the
 * other half, which reads what is actually sitting in a DLQ. R24 added
 * `sqs:ReceiveMessage` on the DLQs to the dashboard role for exactly this,
 * because `GetQueueAttributes` returns a count and never a body.
 */

/** SQS returns at most ten messages per receive, and a panel wants no more. */
export const DLQ_PEEK_LIMIT = 10;

export interface DlqMessage {
  readonly messageId: string;
  readonly body: string;
  /** `ApproximateReceiveCount` — how many times delivery has been attempted. */
  readonly receiveCount: number;
}

export interface DlqInspector {
  peek(queueUrl: string): Promise<DlqMessage[]>;
}

/** The slice of `SQSClient` used here; injected so tests build none. */
export interface SqsReceiveClient {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
}

export function createSqsDlqInspector(client: SqsReceiveClient): DlqInspector {
  return {
    async peek(queueUrl) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: DLQ_PEEK_LIMIT,
          /**
           * The load-bearing parameter. A plain receive hides each message for
           * the queue's visibility timeout, so merely *looking* at a DLQ would
           * hide those messages from the replay handler — an operator would
           * inspect a backlog and then watch replay move nothing. Zero returns
           * them and makes them visible again immediately.
           */
          VisibilityTimeout: 0,
          MessageSystemAttributeNames: [MessageSystemAttributeName.ApproximateReceiveCount],
        }),
      );

      return (response.Messages ?? []).flatMap((message) => {
        // A message with no body is nothing an operator can act on, and
        // rendering `undefined` as a payload would be worse than omitting it.
        if (message.MessageId === undefined || message.Body === undefined) return [];

        return [
          {
            messageId: message.MessageId,
            body: message.Body,
            receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 0) || 0,
          },
        ];
      });
    },
  };
}
