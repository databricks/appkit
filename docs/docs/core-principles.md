# Core principles

Learn about the fundamental concepts and principles behind AppKit.

## 1. Highly opinionated

AppKit must provide a clear path with best practices for building Databricks
applications. We provide strong defaults, with advanced customization when needed.

## 2. Built for application use cases

This SDK is for application development, not infrastructure management.
Databricks' internal implementation details must be abstracted. We're building an
application SDK, not a service wrapper.

## 3. Delightful developer experience

Every interface, doc, example, tool, and implementation must provide developer joy. Combined with the Highly Opinionated principle, this creates a true plug-and-play experience.

## 4. Zero-trust security

Minimize exposed surface area, fail safely by default, and validate all inputs.
AppKit must always have a zero-trust mindset.

## 5. Optimized for humans and AI

Developers and LLMs both use this SDK. Every API must be discoverable,
self-documenting, and inferable by both types of users. Test with both.

## 6. Production-ready from day one

Even the smallest feature can be used by enterprise users, so everything
shipped must be production-ready. Observability, reliability, and scalability
since day one.

## 7. Layered extensibility

AppKit provides high-level plugins, low-level primitives, and extension points for custom plugins. It integrates into any application architecture and never blocks your path forward.

