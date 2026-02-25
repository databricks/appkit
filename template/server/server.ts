import { createApp, {{.plugin_imports}} } from '@databricks/appkit';

createApp({
  plugins: [
    {{.plugin_usages}}
  ],
}).catch(console.error);
