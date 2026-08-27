import { Plugin, type PluginManifest, toPlugin } from '@databricks/appkit';
import { createTestApp, createTestPluginContext, expectStream } from '@databricks/appkit/testing';
import { describe, expect, test } from 'vitest';

/**
 * Example test using the AppKit testing kit (`@databricks/appkit/testing`).
 *
 * The kit lets you test a plugin with NO Databricks workspace, credentials, or
 * network — so these tests run anywhere, including CI. Delete this file, or use
 * it as a starting point for testing your own plugins.
 *
 * Three headline helpers are shown below:
 *  - `createTestApp({ plugins })` — boot a real app (real Express, real routes,
 *    real validation) on an ephemeral port and call it over HTTP. Start here for
 *    a plugin's end-to-end behaviour. Every boot needs `close()`.
 *  - `createTestPluginContext()` — a real PluginContext with faked edges, attachable
 *    to a plugin so its real code paths (routes, tool dispatch, user scoping)
 *    run under test. No boot, no socket — the fastest option for unit tests.
 *  - `expectStream(...).toEmit(...)` — assert the ordered event types a
 *    streaming handler emits.
 *
 * Note: tests instantiate the plugin CLASS directly (`new GreeterPlugin()`).
 * The `analytics()` / `agents()` factory functions you pass to `createApp`
 * return a descriptor for the app to construct — for a unit test you want the
 * instance itself.
 */

// A tiny example plugin: it registers one route and streams two events.
class GreeterPlugin extends Plugin {
  static manifest = {
    name: 'greeter',
    displayName: 'Greeter',
    description: 'Example plugin for the testing-kit demo',
    resources: { required: [], optional: [] },
  } as PluginManifest<'greeter'>;

  async setup() {
    // Routes registered here are captured by createTestPluginContext().routes.
    this.context?.addRoute('get', '/hello', (_req, res) => {
      res.end();
    });
  }

  // A stand-in for a streaming handler: yields SSE-style event objects.
  async *greet(name: string) {
    yield { type: 'greeting_start', name };
    yield { type: 'greeting_end', message: `Hello, ${name}!` };
  }

  // A real HTTP route, so createTestApp has something to call.
  injectRoutes(router: Parameters<Plugin['injectRoutes']>[0]) {
    this.route(router, {
      name: 'greet',
      method: 'post',
      path: '/greet',
      handler: async (req, res) => {
        const { name } = req.body as { name: string };
        res.json({ message: `Hello, ${name}!` });
      },
    });
  }
}

// The factory form `createApp` (and `createTestApp`) take. `toPlugin` reads the
// plugin name from the static manifest.
const greeter = toPlugin(GreeterPlugin);

describe('testing kit example', () => {
  test('attaches a real PluginContext and records registered routes', async () => {
    const mock = createTestPluginContext();
    const plugin = new GreeterPlugin({});

    await mock.attach(plugin);
    await plugin.setup();

    expect(mock.routes).toContainEqual(expect.objectContaining({ method: 'get', path: '/hello' }));
  });

  test('asserts the ordered events a stream emits', async () => {
    const plugin = new GreeterPlugin({});

    await expectStream(plugin.greet('world')).toEmit('greeting_start', 'greeting_end');
  });

  test('boots a real app and calls the plugin over HTTP', async () => {
    // No workspace, no credentials, no network. The harness fakes the whole
    // Databricks data plane and binds an ephemeral port.
    const app = await createTestApp({ plugins: [greeter()] });

    try {
      const res = await app.post('/api/greeter/greet', { body: { name: 'world' } });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: 'Hello, world!' });
    } finally {
      // Required: releases the socket and restores process.env.
      await app.close();
    }
  });
});
