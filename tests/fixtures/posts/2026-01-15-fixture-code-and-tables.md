---
title: "Fixture: code blocks and tables"
summary: "A test article that exercises fenced code, inline code, tables, a blockquote and internal links."
tags: [python, markdown]
---
This fixture article exists for automated checks. It exercises syntax highlighting, inline code, an aligned table, a blockquote and links to another article and to one of its own headings.

## Python example

The function below computes a capped exponential back-off. Call `retry_delay(3)` to get the delay before the fourth attempt.

```python
def retry_delay(attempt, base=0.5, limit=30):
    # Exponential back-off, capped at limit seconds.
    delay = base * 2 ** attempt
    unit = "seconds"
    print("waiting", min(delay, limit), unit)
    return min(delay, limit)
```

## Configuration in YAML

The same policy expressed as service configuration:

```yaml
retry:
  strategy: "exponential"
  base_seconds: 0.5
  limit_seconds: 30
  max_attempts: 5
```

## Sample table

| Strategy    | Attempts | Max delay (s) |
|:------------|:--------:|--------------:|
| Fixed       | 5        | 0.5           |
| Linear      | 5        | 2.5           |
| Exponential | 5        | 8.0           |

## Field notes

> Retries hide failures. Measure every retry before you tune the delay.

The pattern came out of an R&D review held in a small Café near the harbour, where the team compared the three strategies above on a whiteboard.

Read [the escaping fixture](../fixture-escaping-and-liquid/) for Liquid and HTML samples, or [jump to the table](#sample-table) to compare the strategies again.
