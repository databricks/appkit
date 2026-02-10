import { createApp, server, {{.plugin_imports}} } from '@databricks/appkit';

createApp({
  plugins: [
    server(),
    {{.plugin_usages}}
  ],
}).catch(console.error);
