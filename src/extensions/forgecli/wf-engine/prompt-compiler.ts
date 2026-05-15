import * as fs from "node:fs";

export interface PromptContext {
  wf:    { instanceId: string; workingDir: string };
  node:  { execId: string; id: string };
  state: unknown;
  loop?: { item: unknown };
}

export function compilePrompt(promptFile: string, ctx: PromptContext): string {
  let body = fs.readFileSync(promptFile, "utf8");
  body = substitute(body, "{{wf.instanceId}}",   ctx.wf.instanceId);
  body = substitute(body, "{{wf.workingDir}}",   ctx.wf.workingDir);
  body = substitute(body, "{{node.execId}}",     ctx.node.execId);
  body = substitute(body, "{{node.id}}",         ctx.node.id);
  body = substitute(body, "{{state}}",           JSON.stringify(ctx.state, null, 2));
  if (ctx.loop) {
    body = substitute(body, "{{loop.item}}",     JSON.stringify(ctx.loop.item, null, 2));
    // Also support {{loop.item.<key>}} for shallow object access
    if (typeof ctx.loop.item === "object" && ctx.loop.item !== null) {
      for (const [k, v] of Object.entries(ctx.loop.item)) {
        body = substitute(body, `{{loop.item.${k}}}`, String(v));
      }
    }
  }
  return body;
}

function substitute(s: string, token: string, value: string): string {
  return s.split(token).join(value);
}
