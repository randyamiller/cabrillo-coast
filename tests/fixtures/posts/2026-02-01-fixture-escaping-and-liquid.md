---
title: "Escaping \"quotes\" & <angle> brackets"
summary: "A test article whose title needs escaping and whose code samples contain Liquid and HTML."
tags: [liquid, html]
updated: 2026-02-10
---
This fixture article exists for automated checks. Its title contains double quotes, an ampersand and angle brackets, so every layout that prints it must escape it.

## Liquid inside code

Helm chart templates use double braces. The sample below is wrapped in a raw tag, so Jekyll prints it unchanged instead of evaluating it.

{% raw %}
```text
image: {{ .Values.image }}
replicas: {{ .Values.replicaCount }}
```
{% endraw %}

## HTML shown as code

The script element below is a code sample. It must render as escaped text and never run.

```html
<script src="/assets/app.js"></script>
```

## Related articles

Read [the code fixture]({{ site.baseurl }}{% post_url 2026-01-15-fixture-code-and-tables %}) for highlighted code and an aligned table.
