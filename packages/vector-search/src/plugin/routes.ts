import { Router } from 'express';
import type { Request, Response } from 'express';
import type { VectorSearchPlugin } from './VectorSearchPlugin';
import { OboTokenExtractor } from './auth';
import type { SearchRequest } from './types';

export function createVectorSearchRouter(plugin: VectorSearchPlugin): Router {
  const router = Router();

  // POST /:alias/query
  router.post('/:alias/query', async (req: Request, res: Response) => {
    const { alias } = req.params;

    let indexConfig;
    try {
      indexConfig = plugin.resolveIndex(alias);
    } catch (err: any) {
      return res.status(err.statusCode ?? 404).json(err);
    }

    const body: SearchRequest = req.body;

    if (!body.queryText && !body.queryVector) {
      return res.status(400).json({
        code: 'INVALID_QUERY',
        message: 'queryText or queryVector is required',
        statusCode: 400,
      });
    }

    // Resolve auth
    let userToken: string | undefined;
    if (indexConfig.auth === 'on-behalf-of-user') {
      try {
        userToken = OboTokenExtractor.extractFromRequest(req);
      } catch (err: any) {
        return res.status(401).json(err);
      }
    }

    try {
      const client = plugin.getClient();
      const response = await client.query({
        indexName: indexConfig.indexName,
        queryText: body.queryText,
        queryVector: body.queryVector,
        columns: body.columns ?? indexConfig.columns,
        numResults: body.numResults ?? indexConfig.numResults ?? 20,
        queryType: body.queryType ?? indexConfig.queryType ?? 'hybrid',
        filters: body.filters,
        reranker: body.reranker ?? indexConfig.reranker ?? false,
        userToken,
        embeddingFn: indexConfig.embeddingFn,
      });

      return res.json(response);
    } catch (err: any) {
      return res.status(err.statusCode ?? 500).json(err);
    }
  });

  // POST /:alias/next-page
  router.post('/:alias/next-page', async (req: Request, res: Response) => {
    const { alias } = req.params;

    let indexConfig;
    try {
      indexConfig = plugin.resolveIndex(alias);
    } catch (err: any) {
      return res.status(err.statusCode ?? 404).json(err);
    }

    if (!indexConfig.pagination) {
      return res.status(400).json({
        code: 'INVALID_QUERY',
        message: `Pagination is not enabled for index "${alias}"`,
        statusCode: 400,
      });
    }

    const { pageToken } = req.body;
    if (!pageToken) {
      return res.status(400).json({
        code: 'INVALID_QUERY',
        message: 'pageToken is required',
        statusCode: 400,
      });
    }

    let userToken: string | undefined;
    if (indexConfig.auth === 'on-behalf-of-user') {
      try {
        userToken = OboTokenExtractor.extractFromRequest(req);
      } catch (err: any) {
        return res.status(401).json(err);
      }
    }

    try {
      const client = plugin.getClient();
      const response = await client.queryNextPage({
        indexName: indexConfig.indexName,
        endpointName: indexConfig.endpointName!,
        pageToken,
        userToken,
      });

      return res.json(response);
    } catch (err: any) {
      return res.status(err.statusCode ?? 500).json(err);
    }
  });

  // GET /:alias/config
  router.get('/:alias/config', (req: Request, res: Response) => {
    const { alias } = req.params;

    let indexConfig;
    try {
      indexConfig = plugin.resolveIndex(alias);
    } catch (err: any) {
      return res.status(err.statusCode ?? 404).json(err);
    }

    return res.json({
      alias,
      columns: indexConfig.columns,
      queryType: indexConfig.queryType ?? 'hybrid',
      numResults: indexConfig.numResults ?? 20,
      reranker: !!indexConfig.reranker,
      pagination: !!indexConfig.pagination,
    });
  });

  return router;
}
