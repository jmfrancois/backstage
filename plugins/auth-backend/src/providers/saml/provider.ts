/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express from 'express';
import {
  SamlConfig,
  Strategy as SamlStrategy,
  Profile as SamlProfile,
  VerifyWithoutRequest,
} from 'passport-saml';
import {
  executeFrameHandlerStrategy,
  executeRedirectStrategy,
  PassportDoneCallback,
} from '../../lib/passport';
import {
  AuthProviderRouteHandlers,
  ProfileInfo,
  AuthProviderFactory,
} from '../types';
import { postMessageResponse } from '../../lib/flow';
import { TokenIssuer } from '../../identity';

type SamlInfo = {
  userId: string;
  profile: ProfileInfo;
};

export class SamlAuthProvider implements AuthProviderRouteHandlers {
  private readonly strategy: SamlStrategy;
  private readonly tokenIssuer: TokenIssuer;
  private readonly appUrl: string;

  constructor(options: SAMLProviderOptions) {
    this.appUrl = options.appUrl;
    this.tokenIssuer = options.tokenIssuer;
    this.strategy = new SamlStrategy({ ...options }, ((
      profile: SamlProfile,
      done: PassportDoneCallback<SamlInfo>,
    ) => {
      // TODO: There's plenty more validation and profile handling to do here,
      //       this provider is currently only intended to validate the provider pattern
      //       for non-oauth auth flows.
      // TODO: This flow doesn't issue an identity token that can be used to validate
      //       the identity of the user in other backends, which we need in some form.
      done(undefined, {
        userId: profile.nameID!,
        profile: {
          email: profile.email!,
          displayName: profile.displayName as string,
        },
      });
    }) as VerifyWithoutRequest);
  }

  async start(req: express.Request, res: express.Response): Promise<void> {
    const { url } = await executeRedirectStrategy(req, this.strategy, {});
    res.redirect(url);
  }

  async frameHandler(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const {
        response: { userId, profile },
      } = await executeFrameHandlerStrategy<SamlInfo>(req, this.strategy);

      const id = userId;
      const idToken = await this.tokenIssuer.issueToken({
        claims: { sub: id },
      });

      return postMessageResponse(res, this.appUrl, {
        type: 'authorization_response',
        response: {
          providerInfo: {},
          profile,
          backstageIdentity: { id, idToken },
        },
      });
    } catch (error) {
      return postMessageResponse(res, this.appUrl, {
        type: 'authorization_response',
        error: {
          name: error.name,
          message: error.message,
        },
      });
    }
  }

  async logout(_req: express.Request, res: express.Response): Promise<void> {
    res.send('noop');
  }

  identifyEnv(): string | undefined {
    return undefined;
  }
}

type SAMLProviderOptions = SamlConfig & {
  tokenIssuer: TokenIssuer;
  appUrl: string;
};

type SignatureAlgorithm = 'sha1' | 'sha256' | 'sha512';

export const createSamlProvider: AuthProviderFactory = ({
  providerId,
  globalConfig,
  config,
  tokenIssuer,
}) => {
  const opts = {
    callbackUrl: `${globalConfig.baseUrl}/${providerId}/handler/frame`,
    entryPoint: config.getString('entryPoint'),
    logoutUrl: config.getOptionalString('logoutUrl'),
    issuer: config.getString('issuer'),
    cert: config.getOptionalString('cert'),
    privateCert: config.getOptionalString('privateKey'),
    decryptionPvk: config.getOptionalString('decryptionPvk'),
    signatureAlgorithm: config.getOptionalString('signatureAlgorithm') as
      | SignatureAlgorithm
      | undefined,
    digestAlgorithm: config.getOptionalString('digestAlgorithm'),

    tokenIssuer,
    appUrl: globalConfig.appUrl,
  };

  // passport-saml will return an error if the `cert` key is set, and the value is empty.
  // Since we read from config (such as environment variables) an empty string should be equal to being unset.
  if (!opts.cert) {
    delete opts.cert;
  }
  return new SamlAuthProvider(opts);
};
