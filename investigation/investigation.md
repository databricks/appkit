# Generating llms.txt from documentation

## Assumptions
- We use our documentation files as the source of truth.

## Goal
- Ideally: embedded llms.txt files in `appkit` + `appkit-ui` packages

## Research

- @signalwire/docusaurus-plugin-llms-txt - https://github.com/signalwire/docusaurus-plugins
   + supports mdx -> we can render our example codeblock and shared prerequisites
   +  processes final HTML output after Docusaurus builds your site -> captures fully rendered components, resolved data, and processed content that only exists after build time
   - doesn't enable output directory configuration

  Limitations:
   - no way to configure output directory; we cannot configure 2 plugins for appkit and appkit-ui
   - While you can generate Markdown files for versioned docs, llms.txt points only to the latest version.








## Suggested approach

Use the `@signalwire/docusaurus-plugin-llms-txt` Docusaurus plugin to generate llms.txt and llms-full.txt files.

## Options:
1. Host llms.txt and MD files on our website (versioned docs)
2. Embed llms.txt and MD files into the packages
   1. Embed llms.txt and MD files into the packages - all docs files
   2. Split generation for appkit and appkit-ui
      1. Limitations: we'd need to contribute to the plugin to add support for:
         - output dir
         - running the plugin twice to generate separate files for appkit and appkit-ui

In theory, the llms.txt spec is about hosting MD files on website. Also, it will require a manual maintenance to split generation for appkit and appkit-ui (to avoid bundling unnecessary/not relevant files into the llms.txt file).


## Rejected alternatives

### Other Docusaurus plugins

- https://github.com/osodevops/docusaurus-llm-docs
   - too early version, and just GitHub Actions option.
- https://github.com/din0s/docusaurus-plugin-llms-txt
  - Doesn't render or partially render imported React components
- https://github.com/rachfop/docusaurus-plugin-llms
  - Powerful configuration
  - Doesn't render or partially render imported React components

### Arbitrary tools that generate llms.txt from MD/MDX files

**Example:** https://github.com/romankurnovskii/get-llms-txt

We use MDX for UI component examples and shared content (e.g. prerequisites).
Even if `mdx` is supported, it means they skip React components and just use Markdown which isn't ideal.

### HTML to llms.txt / MD tools

**Example:** Mdream Crawl - https://github.com/harlan-zw/mdream?tab=readme-ov-file#mdream-usage

The tools I found crawl live websites which is more time consuming and less reliable.

