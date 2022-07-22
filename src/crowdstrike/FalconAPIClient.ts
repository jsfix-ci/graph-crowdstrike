import fetch, { RequestInfo, RequestInit } from 'node-fetch';
import { retry } from '@lifeomic/attempt';

import { URLSearchParams } from 'url';

import {
  Device,
  DeviceIdentifier,
  OAuth2ClientCredentials,
  OAuth2Token,
  PaginationMeta,
  PaginationParams,
  PreventionPolicy,
  QueryParams,
  RateLimitConfig,
  RateLimitState,
  ResourcesResponse,
  Vulnerability,
} from './types';
import {
  IntegrationLogger,
  IntegrationProviderAPIError,
  IntegrationProviderAuthenticationError,
  IntegrationProviderAuthorizationError,
} from '@jupiterone/integration-sdk-core';

function getUnixTimeNow() {
  return Date.now() / 1000;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  reserveLimit: 30,
  cooldownPeriod: 1000,
};

type AttemptOptions = {
  maxAttempts: number;
  delay: number;
  timeout: number;
  factor: number;
};

export const DEFAULT_ATTEMPT_OPTIONS = {
  maxAttempts: 5,
  delay: 30_000,
  timeout: 180_000,
  factor: 2,
};

export type FalconAPIClientConfig = {
  credentials: OAuth2ClientCredentials;
  logger: IntegrationLogger;
  attemptOptions?: AttemptOptions;
};

export type FalconAPIResourceIterationCallback<T> = (
  resources: T[],
) => boolean | void | Promise<boolean | void>;

export class FalconAPIClient {
  private credentials: OAuth2ClientCredentials;
  private token: OAuth2Token | undefined;
  private logger: IntegrationLogger;
  private readonly rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG;
  private rateLimitState: RateLimitState;
  private attemptOptions: AttemptOptions;

  constructor({ credentials, logger, attemptOptions }: FalconAPIClientConfig) {
    this.credentials = credentials;
    this.logger = logger;
    this.attemptOptions = attemptOptions ?? DEFAULT_ATTEMPT_OPTIONS;
  }

  public async authenticate(): Promise<OAuth2Token> {
    if (!this.token || !isValidToken(this.token)) {
      this.token = await this.requestOAuth2Token();
    }
    return this.token;
  }

  /**
   * Iterates the detected devices by listing the AIDs and then fetching the
   * device details, providing pages of the collection to the provided callback.
   *
   * The scroll API is used because it has no limitation on the number of
   * records it will return. However, note the scroll offset value expires after
   * 2 minutes. The device details request time combined with the callback
   * processing time, per page, must be less.
   *
   * @returns Promise
   */
  public async iterateDevices(input: {
    callback: FalconAPIResourceIterationCallback<Device>;
    query?: QueryParams;
  }): Promise<void> {
    return this.paginateResources<DeviceIdentifier>({
      callback: async (deviceIds) => {
        if (deviceIds.length) {
          // If the scroll lists _no_ recent devices, we don't want to send a malformed request to https://api.crowdstrike.com/devices/entities/devices/v1?
          return await input.callback(await this.fetchDevices(deviceIds));
        }
      },
      query: input.query,
      resourcePath: '/devices/queries/devices-scroll/v1',
    });
  }

  /**
   * Iterates the known device vulnerabilities, providing pages
   * of the collection based on the provided query to the provided callback.
   *
   * @param input
   * @returns Promise
   */
  public async iterateVulnerabilities(input: {
    callBack: FalconAPIResourceIterationCallback<Vulnerability>;
    query?: QueryParams;
  }): Promise<void> {
    return this.paginateResources<Vulnerability>({
      callback: input.callBack,
      query: input.query,
      resourcePath: '/spotlight/combined/vulnerabilities/v1',
    });
  }

  /**
   * Iterates prevention policies using the "combined" API, providing pages of
   * the collection to the provided callback.
   *
   * @returns Promise
   */
  public async iteratePreventionPolicies(input: {
    callback: FalconAPIResourceIterationCallback<PreventionPolicy>;
  }): Promise<void> {
    return this.paginateResources<PreventionPolicy>({
      callback: input.callback,
      resourcePath: '/policy/combined/prevention/v1',
    });
  }

  /**
   * Iterates prevention policy member ids, providing pages of the collection
   * to the provided callback. Based on the provided policy id.
   * @param input
   */
  public async iteratePreventionPolicyMemberIds(input: {
    callback: FalconAPIResourceIterationCallback<DeviceIdentifier>;
    policyId: string;
  }): Promise<void> {
    return this.paginateResources<DeviceIdentifier>({
      callback: input.callback,
      resourcePath: '/policy/queries/prevention-members/v1',
      query: { id: input.policyId },
    });
  }

  private async fetchDevices(ids: string[]): Promise<Device[]> {
    const params = new URLSearchParams();
    for (const aid of ids) {
      params.append('ids', aid);
    }

    const response = await this.executeAPIRequestWithRetries<
      ResourcesResponse<Device>
    >(`https://api.crowdstrike.com/devices/entities/devices/v1?${params}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
    });

    return response.resources;
  }

  private async paginateResources<ResourceType>({
    callback,
    resourcePath,
    query,
  }: {
    callback: FalconAPIResourceIterationCallback<ResourceType>;
    resourcePath: string;
    query?: QueryParams;
  }): Promise<void> {
    let seen: number = 0;
    let total: number = 0;
    let finished = false;

    let paginationParams: PaginationParams | undefined = undefined;

    do {
      const url = `https://api.crowdstrike.com${resourcePath}?${toQueryString(
        paginationParams,
        query,
      )}`;

      this.logger.info({ requestUrl: url, paginationParams });
      const response: ResourcesResponse<ResourceType> =
        await this.executeAPIRequestWithRetries<
          ResourcesResponse<ResourceType>
        >(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
          },
        });

      if (response.errors?.length) {
        const errorsToLog = response.errors.map((err) => {
          return { code: err.code, message: err.message, id: err.id };
        });

        this.logger.error(
          { errors: errorsToLog },
          'encountered error(s) in api response',
        );
      }

      await callback(response.resources);

      this.logger.info(
        {
          pagination: response.meta,
          resourcesLength: response.resources.length,
        },
        'pagination response details',
      );

      paginationParams = response.meta.pagination as PaginationMeta;
      seen += response.resources.length;
      total = paginationParams.total!;
      finished = seen === 0 || seen >= total;

      this.logger.info(
        { seen, total, finished },
        'post-request pagination state',
      );
    } while (!finished);
  }

  private async requestOAuth2Token(): Promise<OAuth2Token> {
    this.logger.info('Fetching new access token');

    const params = new URLSearchParams();
    params.append('client_id', this.credentials.clientId);
    params.append('client_secret', this.credentials.clientSecret);

    const authRequestAttempt = async () => {
      const endpoint = 'https://api.crowdstrike.com/oauth2/token';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
        },
        body: params,
      });

      if (response.ok) {
        return response.json();
      } else {
        throw new IntegrationProviderAPIError({
          status: response.status,
          statusText: /* TODO: JSFIX could not patch the breaking change:
          Response.statusText no longer sets a default message derived from the HTTP status code*/
          response.statusText,
          endpoint,
        });
      }
    };

    const response = await retry(authRequestAttempt, {
      ...this.attemptOptions,
      handleError: (error, attemptContext) => {
        if (error.status === 400) {
          attemptContext.abort();
        }
        if (error.status === 403) {
          throw new IntegrationProviderAuthenticationError({
            status: error.status,
            statusText: error.statusText,
            endpoint: error.endpoint,
          });
        }

        this.logger.warn(
          { attemptContext, error },
          `Hit a possibly recoverable error when authenticating. Waiting before trying again.`,
        );
      },
    });

    const expiresAt = getUnixTimeNow() + response.expires_in;
    this.logger.info(
      {
        expiresAt,
        expires_in: response.expires_in,
      },
      'Fetched new access token',
    );
    return {
      token: response.access_token,
      expiresAt,
    };
  }

  private async executeAPIRequestWithRetries<T>(
    requestUrl: RequestInfo,
    init: RequestInit,
  ): Promise<T> {
    await this.authenticate();

    /**
     * This is the logic to be retried in the case of an error.
     */
    const requestAttempt = async () => {
      const response = await fetch(requestUrl, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `bearer ${this.token!.token}`,
        },
      });

      this.rateLimitState = {
        limitRemaining: Number(response.headers.get('X-RateLimit-Remaining')),
        perMinuteLimit: Number(response.headers.get('X-RateLimit-Limit')),
        retryAfter:
          response.headers.get('X-RateLimit-RetryAfter') &&
          Number(response.headers.get('X-RateLimit-RetryAfter')),
      };

      if (response.ok) {
        return response.json() as T;
      }

      if (response.status === 401) {
        throw new IntegrationProviderAuthenticationError({
          status: response.status,
          statusText: response.statusText,
          endpoint: requestUrl,
        });
      }
      if (response.status === 403) {
        throw new IntegrationProviderAuthorizationError({
          status: response.status,
          statusText: response.statusText,
          endpoint: requestUrl,
        });
      }

      throw new IntegrationProviderAPIError({
        status: response.status,
        statusText: response.statusText,
        endpoint: requestUrl,
      });
    };

    return retry(requestAttempt, {
      ...this.attemptOptions,
      handleError: async (error, attemptContext) => {
        this.logger.debug(
          { error, attemptContext },
          'Error being handled in handleError.',
        );

        if (error.status === 401) {
          if (attemptContext.attemptNum > 1) {
            attemptContext.abort();
          } else {
            await this.authenticate();
          }
        }
        if (error.status === 403) {
          attemptContext.abort();
        }
        if (error.status === 429) {
          await this.handle429Error();
        }

        this.logger.warn(
          { attemptContext, error },
          `Hit a possibly recoverable error when requesting data. Waiting before trying again.`,
        );
      },
    });
  }

  private async handle429Error() {
    const unixTimeNow = getUnixTimeNow();
    /**
     * We have seen in the wild that waiting until the
     * `x-ratelimit-retryafter` unix timestamp before retrying requests
     * does often still result in additional 429 errors. This may be caused
     * by incorrect logic on the API server, out-of-sync clocks between
     * client and server, or something else. However, we have seen that
     * waiting an additional minute does result in successful invocations.
     *
     * `timeToSleepInSeconds` adds 60s to the `retryAfter` property, but
     * may be reduced in the future.
     */
    const timeToSleepInSeconds = this.rateLimitState.retryAfter
      ? this.rateLimitState.retryAfter + 60 - unixTimeNow
      : 0;
    this.logger.info(
      {
        unixTimeNow,
        timeToSleepInSeconds,
        rateLimitState: this.rateLimitState,
        rateLimitConfig: this.rateLimitConfig,
      },
      'Encountered 429 response. Waiting to retry request.',
    );
    await sleep(timeToSleepInSeconds * 1000);

    if (
      this.rateLimitState.limitRemaining &&
      this.rateLimitState.limitRemaining <= this.rateLimitConfig.reserveLimit
    ) {
      this.logger.info(
        {
          rateLimitState: this.rateLimitState,
          rateLimitConfig: this.rateLimitConfig,
        },
        'Rate limit remaining is less than reserve limit. Waiting for cooldown period.',
      );
      await sleep(this.rateLimitConfig.cooldownPeriod);
    }
  }
}

function isValidToken(token: OAuth2Token): boolean {
  return token && token.expiresAt > getUnixTimeNow();
}

function toQueryString(
  pagination?: {
    limit?: number;
    offset?: number | string;
    after?: number | string;
  },
  queryParams?: object,
): URLSearchParams {
  const params = new URLSearchParams();

  if (pagination) {
    if (typeof pagination.limit === 'number') {
      params.append('limit', String(pagination.limit));
    }
    if (pagination.offset !== undefined) {
      params.append('offset', String(pagination.offset));
    }
    if (pagination.after !== undefined) {
      params.append('after', String(pagination.after));
    }
  }

  if (queryParams) {
    for (const e of Object.entries(queryParams)) {
      params.append(e[0], String(e[1]));
    }
  }

  return params;
}
