import { describe, expect, test } from "vitest";
import { createOpenRouterDiagnoser, DIAGNOSIS_SCHEMA, parseDiagnosis } from "./diagnoser";

const answer = { summary: "The bot token is rejected", cause: "HTTP 401", fix: "Rotate it" };
const response = (text: string) => ({ content: [{ type: "text", text }] });
const report = {
  stage: "publish",
  error: "telegram rejected",
  cause: "Error: 401",
  attempts: 5,
  payload: '{"messageId":"m1"}',
};

describe("diagnoser", () => {
  test("sends the report with the diagnosis schema and reads the answer", async () => {
    const requests: unknown[] = [];
    const diagnoser = createOpenRouterDiagnoser({
      client: {
        create: async (request) => {
          requests.push(request);
          return response(JSON.stringify(answer));
        },
      },
    });

    expect(await diagnoser.diagnose(report)).toEqual(answer);
    expect(requests[0]).toMatchObject({
      output_config: { format: { type: "json_schema", schema: DIAGNOSIS_SCHEMA } },
      messages: [{ role: "user", content: JSON.stringify(report) }],
    });
  });

  test("an answer missing the fix is an error, not a half diagnosis", () => {
    expect(() => parseDiagnosis(response(JSON.stringify({ summary: "s", cause: "c" })))).toThrow();
  });

  test("without a client or a key it fails as a wiring fault", async () => {
    await expect(createOpenRouterDiagnoser().diagnose(report)).rejects.toThrow(/API key provider/);
  });
});
