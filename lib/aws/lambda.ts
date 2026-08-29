import { InvokeCommand, type InvokeCommandOutput } from "@aws-sdk/client-lambda";

/**
 * §8.2 L734 — "manual triggers call `lambda:InvokeFunction` on the deployed
 * function, so 'run this now' executes the exact deployed artefact."
 *
 * A port, so the dashboard's tests never build a Lambda client — and so the
 * dashboard never imports `lib/pipeline/` to get the same effect.
 */
export interface LambdaInvoker {
  invoke(functionName: string, payload: unknown): Promise<unknown>;
}

/** The slice of `LambdaClient` used here; injected so tests build none. */
export interface LambdaInvokeClient {
  send(command: InvokeCommand): Promise<InvokeCommandOutput>;
}

export function lambdaInvoker(client: LambdaInvokeClient): LambdaInvoker {
  return {
    async invoke(functionName, payload) {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          // Synchronous: §8.4 L752 and L754 both return a count, so the operator
          // has to wait for one. `Event` would return 202 and no summary at all.
          InvocationType: "RequestResponse",
          Payload: JSON.stringify(payload),
        }),
      );

      const body = response.Payload === undefined ? "" : new TextDecoder().decode(response.Payload);

      /**
       * A handler that throws still answers HTTP 200; the failure is in
       * `FunctionError`, and the payload is then the error, not the summary.
       * Ignoring it would show an operator a successful-looking trigger that did
       * nothing.
       */
      if (response.FunctionError !== undefined) {
        throw new Error(`${functionName} failed (${response.FunctionError}): ${body}`);
      }

      return body === "" ? undefined : JSON.parse(body);
    },
  };
}
