/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { UsageCounter } from '@kbn/usage-collection-plugin/server';
import type { AlertingRouter } from '../../types';
import { ILicenseState } from '../../lib/license_state';
import { verifyApiAccess } from '../../lib/license_api_access';
import { LEGACY_BASE_ALERT_API_PATH } from '../../../common';
import { handleDisabledApiKeysError } from '../lib/error_handler';
import { RuleTypeDisabledError } from '../../lib/errors/rule_type_disabled';
import { trackLegacyRouteUsage } from '../../lib/track_legacy_route_usage';

const paramSchema = schema.object({
  id: schema.string(),
});

export const enableAlertRoute = (
  router: AlertingRouter,
  licenseState: ILicenseState,
  usageCounter?: UsageCounter,
  isServerless?: boolean
) => {
  router.post(
    {
      path: `${LEGACY_BASE_ALERT_API_PATH}/alert/{id}/_enable`,
      validate: {
        params: paramSchema,
      },
      options: {
        access: isServerless ? 'internal' : 'public',
        summary: 'Enable an alert',
        tags: ['oas-tag:alerting'],
        // @ts-expect-error TODO(https://github.com/elastic/kibana/issues/196095): Replace {RouteDeprecationInfo}
        deprecated: true,
      },
    },
    handleDisabledApiKeysError(
      router.handleLegacyErrors(async function (context, req, res) {
        verifyApiAccess(licenseState);
        if (!context.alerting) {
          return res.badRequest({ body: 'RouteHandlerContext is not registered for alerting' });
        }
        trackLegacyRouteUsage('enable', usageCounter);
        const rulesClient = (await context.alerting).getRulesClient();
        const { id } = req.params;
        try {
          await rulesClient.enableRule({ id });
          return res.noContent();
        } catch (e) {
          if (e instanceof RuleTypeDisabledError) {
            return e.sendResponse(res);
          }
          throw e;
        }
      })
    )
  );
};
