/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import type { IHttpFetchError } from '@kbn/core-http-browser';
import { dateParser } from '../../common/utils';
import { DATA_USAGE_METRICS_API_ROUTE } from '../../common';
import type {
  UsageMetricsRequestBody,
  UsageMetricsResponseSchemaBody,
} from '../../common/rest_types';
import { useKibanaContextForPlugin } from '../utils/use_kibana';

interface ErrorType {
  statusCode: number;
  message: string;
}

export const useGetDataUsageMetrics = (
  body: UsageMetricsRequestBody,
  options: UseQueryOptions<UsageMetricsResponseSchemaBody, IHttpFetchError<ErrorType>> = {}
): UseQueryResult<UsageMetricsResponseSchemaBody, IHttpFetchError<ErrorType>> => {
  const { http } = useKibanaContextForPlugin().services;

  return useQuery<UsageMetricsResponseSchemaBody, IHttpFetchError<ErrorType>>({
    queryKey: ['get-data-usage-metrics', body],
    ...options,
    keepPreviousData: true,
    queryFn: async ({ signal }) => {
      return http
        .post<UsageMetricsResponseSchemaBody>(DATA_USAGE_METRICS_API_ROUTE, {
          signal,
          version: '1',
          body: JSON.stringify({
            from: dateParser(body.from),
            to: dateParser(body.to),
            metricTypes: body.metricTypes,
            dataStreams: body.dataStreams,
          }),
        })
        .catch((error) => {
          throw error.body;
        });
    },
  });
};
