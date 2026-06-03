import {
  ResourceStatusIndicator,
  ResourceStatusProvider,
} from '@databricks/appkit-ui/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {/*
       * ResourceStatusProvider aggregates readiness signals (e.g. SQL
       * warehouse cold-starts, Lakebase warm-ups) published by AppKit hooks
       * across the whole tree. ResourceStatusIndicator surfaces them as a
       * single floating affordance in the corner — no per-component wiring
       * required. Both are no-ops when nothing's pending. Remove or replace
       * with a custom indicator if you'd rather render the aggregate
       * yourself via useResourceStatus().
       */}
      <ResourceStatusProvider>
        <ResourceStatusIndicator />
        <App />
      </ResourceStatusProvider>
    </ErrorBoundary>
  </StrictMode>
);
