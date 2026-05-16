# Custom tools

## `forge_ask_user` — interactive prompt

The `forge_ask_user` custom tool allows Forge workflows to request user input during model execution. It presents the appropriate TUI prompt and blocks the model loop until the user responds.

### Schema

```typescript
{
  question: string;         // The prompt shown to the user
  type: "confirm"           // Y/N boolean confirmation
       | "choice"           // Select from a list
       | "text";            // Free-form single-line input
  options?: string[];       // Required when type === "choice"
  default?: string;         // Returned in non-interactive mode
}
```

### Returns

A string — `"Y"` or `"N"` for `confirm`, the selected option for `choice`, or the entered text for `text`. On cancellation (user dismisses the dialog), the tool returns `isError: true` with a structured message.

### Examples

```ts
// Confirm
forge_ask_user({ question: "Overwrite existing files?", type: "confirm" })
// → "Y" or "N"

// Choice
forge_ask_user({
  question: "Select environment:",
  type: "choice",
  options: ["development", "staging", "production"]
})
// → "development" | "staging" | "production"

// Text
forge_ask_user({ question: "Enter project name:", type: "text", default: "myproject" })
// → user-entered string (or "myproject" in non-interactive mode)
```

### Non-interactive behavior

When `FORGE_YES=1`, `--non-interactive` is set, or pi is running in headless/RPC mode, the tool returns the `default` immediately without rendering any TUI. Fallback defaults when no explicit `default` is provided:

- `confirm` → `"Y"`
- `choice` → `options[0]`
- `text` → `""`

See [non-interactive.md](non-interactive.md) for the broader non-interactive contract.
