# Generating llms.txt from documentation

## Assumption
- We use our documentation files as the source of truth.

## Goal
- Ideally: embedded llms.txt files in appkit + appkit-ui packages



## Researc

- @signalwire/docusaurus-plugin-llms-txt - https://github.com/signalwire/docusaurus-plugins
   + supports mdx -> we can render our example codeblock and shared prerequisites
   +  processes final HTML output after Docusaurus builds your site -> captures fully rendered components, resolved data, and processed content that only exists after build time
   - doesn't enable output directory configuration

  Limitations:
   - no way to configure output directory; I would like to run 2 plugins for appkit and appkit-ui

  Questions:
    - should we host MD files for the llms.txt file or embed into the package?



- https://github.com/osodevops/docusaurus-llm-docs
   - too fresh and just github actions option

- https://github.com/din0s/docusaurus-plugin-llms-txt




- https://github.com/rachfop/docusaurus-plugin-llms
  - Powerful config
  - Doesn't render or partially render imported React components



Alternative, arbitrary tools:
    Even if mdx is supported, it means they skip React components and just use markdown, e.g. here: https://github.com/romankurnovskii/get-llms-txt
     - we'd like to keep examples



# Options
1. Docusaurus plugin
1. Arbitrary MD/MDX tool 
    Even if mdx is supported, it means they skip React components and just use markdown, e.g. here: https://github.com/romankurnovskii/get-llms-txt
    and we would like to keep examples and shared prerequisites etc.
2. HTML -> MD - Mdream Crawl
    https://github.com/harlan-zw/mdream?tab=readme-ov-file#mdream-usage