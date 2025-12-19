---
description: Review staged changes against Databricks AppKit principles
---

# Code Review for Staged Changes

Please review the **staged changes** (git diff --cached) in this repository against the Databricks AppKit Core Principles.

## Context

This is the **Databricks Apps Kit** (@databricks/appkit) - a modular TypeScript SDK for building Databricks apps with workflows and plugins.

## SDK Core Principles

### 1. Highly Opinionated
The SDK must provide a clear path with best practices for building Databricks applications. We provide strong defaults, with advanced customization when needed.

### 2. Built for Application Use Cases
This SDK is for application development, not infrastructure management. Databricks' internal implementation details must be abstracted. We're building an application SDK, not a service wrapper.

### 3. Delightful Developer Experience
Every interface, doc, example, tool, and implementation must provide developer joy. Combined with the Highly Opinionated principle, this creates a true plug-and-play experience.

### 4. Zero-Trust Security
Minimize exposed surface area, fail safely by default, and validate all inputs. The SDK must always have a zero-trust mindset.

### 5. Optimized for Humans and AI
Developers and LLMs both use this SDK. Every API must be discoverable, self-documenting, and inferable by both types of users. Test with both.

### 6. Production-Ready from Day One
Even the smallest feature can be used by enterprise users, so everything shipped must be production-ready. Observability, reliability, and scalability since day one.

### 7. Layered Extensibility
The SDK provides high-level plugins, low-level primitives, and extension points for custom plugins. It integrates into any application architecture and never blocks your path forward.

## Review Instructions

1. Show the staged changes: `git diff --cached`

2. Evaluate each change against the 7 Core Principles above

3. Provide specific feedback on how the changes align with or violate each principle

4. Give actionable recommendations for improvements
