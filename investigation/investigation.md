# Generating llms.txt from documentation

This document describes the process of generating AI documentation from the AppKit documentation.

## Introduction

The AppKit documentation combines both manual, human-written content (like guides, tutorials, examples, best practices, etc.), and also generated content from the codebase (like API references, UI components with live preview, etc.).

As we aim to keep it up to date and accurate, the assumption is that the AI-targeted documentation should use the same source of truth as the human-targeted documentation.
Like with the human-targeted documentation, the AI-targeted documentation can combine both manual guidance and generated content.

After generating the AI documentation, we can deliver it in multiple ways:
- host it on the documentation website (for versioned docs)
- or either post-process the generated files to embed them into the `npm` packages

## Options

```mermaid
flowchart LR
    A[Markdown files] --> B[Docusaurus build] --> C[HTML files] --> D[Live website]
```

Assuming that the AI documentation is generated from our documentation, that means we could either:
- generate it from the MD/MDX files
- generate it from the output HTML files
- crawl the live website (let's treat this as a last resort: it's too time consuming and less reliable)

As our documentation website is built with Docusaurus, for both options we could use a dedicated plugin that integrates with Docusaurus build process.

## Suggested approach

After investigation of multiple tools, the best option seems to be to use the [`@signalwire/docusaurus-plugin-llms-txt`](https://github.com/signalwire/docusaurus-plugins/tree/main/packages/docusaurus-plugin-llms-txt) 2.0 Docusaurus plugin to generate:
 - `llms.txt` along with Markdown files for every document on the website
 - `llms-full.txt` file with embedded Markdown content for every document on the website

### Pros
- It processes final HTML output after Docusaurus builds your site. As a result, the shared content (e.g. Prerequisites) and UI components code blocks are properly rendered
- The configuration is very powerful...

### Limitations
- .. But it misses generation output location
- You can generate Markdown files for versioned docs, but `llms.txt` points only to the latest version.
- And it cannot be configured multiple times to generate separate files for `appkit` and `appkit-ui` packages with a single site build.

All those limitations can be resolved by contributions to the plugin, post-processing of the generated files, or a combination of both.

## Options:
1. Host `llms.txt` and MD files on our website (versioned docs)
   - Advantage: We can update the AI docs without releasing new versions of the packages
   - Downside: Agent needs to fetch the documentation from the website which are not as reliable as the local files
2. Embed `llms.txt` and MD files into the packages
   1. Embed llms.txt and MD files into the packages - all docs files
   2. Split generation for appkit and appkit-ui
      1. Limitations: we'd need to contribute to the plugin to add support for:
         - output dir
         - running the plugin twice to generate separate files for appkit and appkit-ui - current hacky way to do it is to run the docs build twice with different plugin config

In theory, the llms.txt spec is about hosting MD files on website. Also, it will require a manual maintenance to split generation for appkit and appkit-ui (to avoid bundling unnecessary/not relevant files into the llms.txt file).

## Rejected alternatives

### Arbitrary tools that generate llms.txt from MD/MDX files

**Example:** https://github.com/romankurnovskii/get-llms-txt

We use MDX for UI component examples and shared content (e.g. prerequisites).
Even if `mdx` is supported, it means they skip React components and just use Markdown which isn't ideal.

### HTML to llms.txt / MD tools

**Example:** Mdream Crawl - https://github.com/harlan-zw/mdream?tab=readme-ov-file#mdream-usage

The tools I found crawl live websites which is more time consuming and less reliable.

### Other Docusaurus plugins

- https://github.com/osodevops/docusaurus-llm-docs
   - just GitHub Actions option
- https://github.com/din0s/docusaurus-plugin-llms-txt
  - Doesn't render or partially render imported React components
- https://github.com/rachfop/docusaurus-plugin-llms
  - Powerful configuration
  - Doesn't render or partially render imported React components
