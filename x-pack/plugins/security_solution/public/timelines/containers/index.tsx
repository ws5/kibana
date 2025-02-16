/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import deepEqual from 'fast-deep-equal';
import { isEmpty, noop } from 'lodash/fp';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Subscription } from 'rxjs';

import type { DataView } from '@kbn/data-plugin/common';
import { isRunningResponse } from '@kbn/data-plugin/common';
import { DataLoadingState } from '@kbn/unified-data-table';
import type {
  TimelineEqlRequestOptionsInput,
  TimelineEventsAllOptionsInput,
} from '@kbn/timelines-plugin/common/api/search_strategy';
import type { ESQuery } from '../../../common/typed_json';

import type { inputsModel } from '../../common/store';
import type { RunTimeMappings } from '../../sourcerer/store/model';
import { useKibana } from '../../common/lib/kibana';
import { createFilter } from '../../common/containers/helpers';
import { timelineActions } from '../store';
import { detectionsTimelineIds } from './helpers';
import { getInspectResponse } from '../../helpers';
import type {
  PaginationInputPaginated,
  TimelineEventsAllStrategyResponse,
  TimelineEdges,
  TimelineItem,
  TimelineRequestSortField,
} from '../../../common/search_strategy';
import { Direction, TimelineEventsQueries } from '../../../common/search_strategy';
import type { InspectResponse } from '../../types';
import type { KueryFilterQueryKind } from '../../../common/types/timeline';
import { TimelineId } from '../../../common/types/timeline';
import { useRouteSpy } from '../../common/utils/route/use_route_spy';
import { activeTimeline } from './active_timeline_context';
import type {
  EqlOptions,
  TimelineEqlResponse,
} from '../../../common/search_strategy/timeline/events/eql';
import { useTrackHttpRequest } from '../../common/lib/apm/use_track_http_request';
import { APP_UI_ID } from '../../../common/constants';
import { useFetchNotes } from '../../notes/hooks/use_fetch_notes';

export interface TimelineArgs {
  events: TimelineItem[];
  id: string;
  inspect: InspectResponse;
  loadPage: LoadPage;
  pageInfo: Pick<PaginationInputPaginated, 'activePage' | 'querySize'>;
  refetch: inputsModel.Refetch;
  totalCount: number;
  refreshedAt: number;
}

type OnNextResponseHandler = (response: TimelineArgs) => Promise<void> | void;

type TimelineEventsSearchHandler = (onNextResponse?: OnNextResponseHandler) => void;

type LoadPage = (newActivePage: number) => void;

type TimelineRequest<T extends KueryFilterQueryKind> = T extends 'kuery'
  ? TimelineEventsAllOptionsInput
  : T extends 'lucene'
  ? TimelineEventsAllOptionsInput
  : T extends 'eql'
  ? TimelineEqlRequestOptionsInput
  : TimelineEventsAllOptionsInput;

type TimelineResponse<T extends KueryFilterQueryKind> = T extends 'kuery'
  ? TimelineEventsAllStrategyResponse
  : T extends 'lucene'
  ? TimelineEventsAllStrategyResponse
  : T extends 'eql'
  ? TimelineEqlResponse
  : TimelineEventsAllStrategyResponse;

export interface UseTimelineEventsProps {
  dataViewId: string | null;
  endDate?: string;
  eqlOptions?: EqlOptions;
  fields: string[];
  filterQuery?: ESQuery | string;
  id: string;
  indexNames: string[];
  language?: KueryFilterQueryKind;
  limit: number;
  runtimeMappings: RunTimeMappings;
  skip?: boolean;
  sort?: TimelineRequestSortField[];
  startDate?: string;
  timerangeKind?: 'absolute' | 'relative';
  fetchNotes?: boolean;
}

const getTimelineEvents = (timelineEdges: TimelineEdges[]): TimelineItem[] =>
  timelineEdges.map((e: TimelineEdges) => e.node);

const ID = 'timelineEventsQuery';
export const initSortDefault: TimelineRequestSortField[] = [
  {
    field: '@timestamp',
    direction: Direction.asc,
    type: 'date',
    esTypes: ['date'],
  },
];

const deStructureEqlOptions = (eqlOptions?: EqlOptions) => ({
  ...(!isEmpty(eqlOptions?.eventCategoryField)
    ? {
        eventCategoryField: eqlOptions?.eventCategoryField,
      }
    : {}),
  ...(!isEmpty(eqlOptions?.size)
    ? {
        size: eqlOptions?.size,
      }
    : {}),
  ...(!isEmpty(eqlOptions?.tiebreakerField)
    ? {
        tiebreakerField: eqlOptions?.tiebreakerField,
      }
    : {}),
  ...(!isEmpty(eqlOptions?.timestampField)
    ? {
        timestampField: eqlOptions?.timestampField,
      }
    : {}),
});

export const useTimelineEventsHandler = ({
  dataViewId,
  endDate,
  eqlOptions = undefined,
  id = ID,
  indexNames,
  fields,
  filterQuery,
  runtimeMappings,
  startDate,
  language = 'kuery',
  limit,
  sort = initSortDefault,
  skip = false,
  timerangeKind,
}: UseTimelineEventsProps): [DataLoadingState, TimelineArgs, TimelineEventsSearchHandler] => {
  const [{ pageName }] = useRouteSpy();
  const dispatch = useDispatch();
  const { data } = useKibana().services;
  const refetch = useRef<inputsModel.Refetch>(noop);
  const abortCtrl = useRef(new AbortController());
  const searchSubscription$ = useRef(new Subscription());
  const [loading, setLoading] = useState<DataLoadingState>(DataLoadingState.loaded);
  const [activePage, setActivePage] = useState(
    id === TimelineId.active ? activeTimeline.getActivePage() : 0
  );
  const [timelineRequest, setTimelineRequest] = useState<TimelineRequest<typeof language> | null>(
    null
  );
  const prevTimelineRequest = useRef<TimelineRequest<typeof language> | null>(null);
  const { startTracking } = useTrackHttpRequest();

  const clearSignalsState = useCallback(() => {
    if (id != null && detectionsTimelineIds.some((timelineId) => timelineId === id)) {
      dispatch(timelineActions.clearEventsLoading({ id }));
      dispatch(timelineActions.clearEventsDeleted({ id }));
    }
  }, [dispatch, id]);

  const wrappedLoadPage = useCallback(
    (newActivePage: number) => {
      clearSignalsState();

      if (id === TimelineId.active) {
        activeTimeline.setActivePage(newActivePage);
      }
      setActivePage(newActivePage);
    },
    [clearSignalsState, id]
  );

  const refetchGrid = useCallback(() => {
    if (refetch.current != null) {
      refetch.current();
    }
    wrappedLoadPage(0);
  }, [wrappedLoadPage]);

  const [timelineResponse, setTimelineResponse] = useState<TimelineArgs>({
    id,
    inspect: {
      dsl: [],
      response: [],
    },
    refetch: refetchGrid,
    totalCount: -1,
    pageInfo: {
      activePage: 0,
      querySize: 0,
    },
    events: [],
    loadPage: wrappedLoadPage,
    refreshedAt: 0,
  });

  const timelineSearch = useCallback(
    async (
      request: TimelineRequest<typeof language> | null,
      onNextHandler?: OnNextResponseHandler
    ) => {
      if (request == null || pageName === '' || skip) {
        return;
      }

      const asyncSearch = async () => {
        prevTimelineRequest.current = request;
        abortCtrl.current = new AbortController();
        if (activePage === 0) {
          setLoading(DataLoadingState.loading);
        } else {
          setLoading(DataLoadingState.loadingMore);
        }
        const { endTracking } = startTracking({ name: `${APP_UI_ID} timeline events search` });
        searchSubscription$.current = data.search
          .search<TimelineRequest<typeof language>, TimelineResponse<typeof language>>(request, {
            strategy:
              request.language === 'eql' ? 'timelineEqlSearchStrategy' : 'timelineSearchStrategy',
            abortSignal: abortCtrl.current.signal,
            // we only need the id to throw better errors
            indexPattern: { id: dataViewId } as unknown as DataView,
          })
          .subscribe({
            next: (response) => {
              if (!isRunningResponse(response)) {
                endTracking('success');
                setLoading(DataLoadingState.loaded);
                setTimelineResponse((prevResponse) => {
                  const newTimelineResponse = {
                    ...prevResponse,
                    events: getTimelineEvents(response.edges),
                    inspect: getInspectResponse(response, prevResponse.inspect),
                    pageInfo: response.pageInfo,
                    totalCount: response.totalCount,
                    refreshedAt: Date.now(),
                  };
                  if (id === TimelineId.active) {
                    activeTimeline.setPageName(pageName);
                    if (request.language === 'eql') {
                      activeTimeline.setEqlRequest(request as TimelineEqlRequestOptionsInput);
                      activeTimeline.setEqlResponse(newTimelineResponse);
                    } else {
                      activeTimeline.setRequest(request);
                      activeTimeline.setResponse(newTimelineResponse);
                    }
                  }
                  if (onNextHandler) onNextHandler(newTimelineResponse);
                  return newTimelineResponse;
                });

                searchSubscription$.current.unsubscribe();
              }
            },
            error: (msg) => {
              endTracking(abortCtrl.current.signal.aborted ? 'aborted' : 'error');
              setLoading(DataLoadingState.loaded);
              data.search.showError(msg);
              searchSubscription$.current.unsubscribe();
            },
          });
      };

      if (
        id === TimelineId.active &&
        activeTimeline.getPageName() !== '' &&
        pageName !== activeTimeline.getPageName()
      ) {
        activeTimeline.setPageName(pageName);
        abortCtrl.current.abort();
        setLoading(DataLoadingState.loaded);

        if (request.language === 'eql') {
          prevTimelineRequest.current = activeTimeline.getEqlRequest();
        } else {
          prevTimelineRequest.current = activeTimeline.getRequest();
        }
        refetch.current = asyncSearch;

        setTimelineResponse((prevResp) => {
          const resp =
            request.language === 'eql'
              ? activeTimeline.getEqlResponse()
              : activeTimeline.getResponse();
          if (resp != null) {
            return {
              ...resp,
              refetch: refetchGrid,
              loadPage: wrappedLoadPage,
            };
          }
          return prevResp;
        });
        if (request.language !== 'eql' && activeTimeline.getResponse() != null) {
          return;
        } else if (request.language === 'eql' && activeTimeline.getEqlResponse() != null) {
          return;
        }
      }

      searchSubscription$.current.unsubscribe();
      abortCtrl.current.abort();
      await asyncSearch();
      refetch.current = asyncSearch;
    },
    [
      pageName,
      skip,
      id,
      activePage,
      startTracking,
      data.search,
      dataViewId,
      refetchGrid,
      wrappedLoadPage,
    ]
  );

  useEffect(() => {
    if (indexNames.length === 0) {
      return;
    }

    setTimelineRequest((prevRequest) => {
      const prevEqlRequest = prevRequest as TimelineEqlRequestOptionsInput;
      const prevSearchParameters = {
        defaultIndex: prevRequest?.defaultIndex ?? [],
        filterQuery: prevRequest?.filterQuery ?? '',
        querySize: prevRequest?.pagination?.querySize ?? 0,
        sort: prevRequest?.sort ?? initSortDefault,
        timerange: prevRequest?.timerange ?? {},
        runtimeMappings: (prevRequest?.runtimeMappings ?? {}) as unknown as RunTimeMappings,
        ...deStructureEqlOptions(prevEqlRequest),
      };

      const timerange =
        startDate && endDate
          ? { timerange: { interval: '12h', from: startDate, to: endDate } }
          : {};
      const currentSearchParameters = {
        defaultIndex: indexNames,
        filterQuery: createFilter(filterQuery),
        querySize: limit,
        sort,
        runtimeMappings,
        ...timerange,
        ...deStructureEqlOptions(eqlOptions),
      };

      const newActivePage = deepEqual(prevSearchParameters, currentSearchParameters)
        ? activePage
        : 0;

      /*
       * optimization to avoid unnecessary network request when a field
       * has already been fetched
       *
       */

      let finalFieldRequest = fields;

      const newFieldsRequested = fields.filter(
        (field) => !prevRequest?.fieldRequested?.includes(field)
      );
      if (newFieldsRequested.length > 0) {
        finalFieldRequest = [...(prevRequest?.fieldRequested ?? []), ...newFieldsRequested];
      } else {
        finalFieldRequest = prevRequest?.fieldRequested ?? [];
      }

      const currentRequest = {
        defaultIndex: indexNames,
        factoryQueryType: TimelineEventsQueries.all,
        fieldRequested: finalFieldRequest,
        fields: finalFieldRequest,
        filterQuery: createFilter(filterQuery),
        pagination: {
          activePage: newActivePage,
          querySize: limit,
        },
        language,
        runtimeMappings,
        sort,
        ...timerange,
        ...(eqlOptions ? eqlOptions : {}),
      } as const;

      if (activePage !== newActivePage) {
        setActivePage(newActivePage);
        if (id === TimelineId.active) {
          activeTimeline.setActivePage(newActivePage);
        }
      }
      if (!deepEqual(prevRequest, currentRequest)) {
        return currentRequest;
      }
      return prevRequest;
    });
  }, [
    dispatch,
    indexNames,
    activePage,
    endDate,
    eqlOptions,
    filterQuery,
    id,
    language,
    limit,
    startDate,
    sort,
    fields,
    runtimeMappings,
  ]);

  const timelineSearchHandler = useCallback(
    async (onNextHandler?: OnNextResponseHandler) => {
      if (
        id !== TimelineId.active ||
        timerangeKind === 'absolute' ||
        !deepEqual(prevTimelineRequest.current, timelineRequest)
      ) {
        await timelineSearch(timelineRequest, onNextHandler);
      }
    },
    [id, timelineRequest, timelineSearch, timerangeKind]
  );

  /*
    cleanup timeline events response when the filters were removed completely
    to avoid displaying previous query results
  */
  useEffect(() => {
    if (isEmpty(filterQuery)) {
      setTimelineResponse({
        id,
        inspect: {
          dsl: [],
          response: [],
        },
        refetch: refetchGrid,
        totalCount: -1,
        pageInfo: {
          activePage: 0,
          querySize: 0,
        },
        events: [],
        loadPage: wrappedLoadPage,
        refreshedAt: 0,
      });
    }
  }, [filterQuery, id, refetchGrid, wrappedLoadPage]);

  return [loading, timelineResponse, timelineSearchHandler];
};

export const useTimelineEvents = ({
  dataViewId,
  endDate,
  eqlOptions = undefined,
  id = ID,
  indexNames,
  fields,
  filterQuery,
  runtimeMappings,
  startDate,
  language = 'kuery',
  limit,
  sort = initSortDefault,
  skip = false,
  timerangeKind,
  fetchNotes = true,
}: UseTimelineEventsProps): [DataLoadingState, TimelineArgs] => {
  const [dataLoadingState, timelineResponse, timelineSearchHandler] = useTimelineEventsHandler({
    dataViewId,
    endDate,
    eqlOptions,
    id,
    indexNames,
    fields,
    filterQuery,
    runtimeMappings,
    startDate,
    language,
    limit,
    sort,
    skip,
    timerangeKind,
  });
  const { onLoad } = useFetchNotes();

  const onTimelineSearchComplete: OnNextResponseHandler = useCallback(
    (response) => {
      if (fetchNotes) onLoad(response.events);
    },
    [fetchNotes, onLoad]
  );

  useEffect(() => {
    if (!timelineSearchHandler) return;
    timelineSearchHandler(onTimelineSearchComplete);
  }, [timelineSearchHandler, onTimelineSearchComplete]);

  return [dataLoadingState, timelineResponse];
};
