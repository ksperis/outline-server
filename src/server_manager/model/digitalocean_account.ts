// Copyright 2020 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {DigitalOceanApiClient, HttpError, NetworkError} from '../cloud/digitalocean_api';
import * as crypto from '../infrastructure/crypto';
import * as do_install_script from '../install_scripts/do_install_script';
import {DigitalOceanServer} from '../web_app/digitalocean_server';

import * as account from './account';
import {AccountId} from './account';
import {EventEmitter} from "eventemitter3";
import {CloudProviderId} from "./cloud";
import {ShadowboxSettings} from "../web_app/shadowbox_server";
import {AccountManager} from "./account_manager";

const SHADOWBOX_TAG = 'shadowbox';
const MACHINE_SIZE = 's-1vcpu-1gb';

export interface DigitalOceanLocation {
  regionId: string;
  dataCenterIds: string[];
}

// TODO: Update with new statuses (e.g. WARNING, LOCKED)
export enum DigitalOceanStatus {
  ACTIVE,
  EMAIL_NOT_VERIFIED,
  INVALID_BILLING,
  UNKNOWN,
}

/**
 * DigitalOcean API account credentials (e.g. OAuth access token or Personal
 * Access Token).
 */
export type DigitalOceanCredentials = string;

// TODO: Cache account data so that we don't fetch on every request.
export class DigitalOceanAccount implements account.Account {
  /**
   * Event that signals an issue connecting to the DigitalOcean API. This
   * usually means an invalid authentication, CORS, or network issue.
   *
   * @event account-connectivity-issue
   * @property {DigitalOceanAccount} account
   */
  public static EVENT_ACCOUNT_CONNECTIVITY_ISSUE = 'account-connectivity-issue';

  private readonly accountId: AccountId;
  private readonly apiClient: DigitalOceanApiClient;
  private servers: DigitalOceanServer[] = [];

  constructor(
      private readonly cloudSpecificId: string,
      private readonly credentials: DigitalOceanCredentials,
      private readonly domainEvents: EventEmitter,
      private readonly accountManager: AccountManager,
      private readonly shadowboxSettings: ShadowboxSettings) {
    this.accountId = {
      cloudSpecificId,
      cloudProviderId: CloudProviderId.DigitalOcean
    };
    this.apiClient = new DigitalOceanApiClient(credentials);
  }

  registerAccountConnectionIssueListener(fn: () => void) {
    this.domainEvents.on(DigitalOceanAccount.EVENT_ACCOUNT_CONNECTIVITY_ISSUE, fn);
  }

  /** The Account identifier that encapsulates the DigitalOcean account. */
  getId(): AccountId {
    return this.accountId;
  }

  /**
   * The DigitalOcean API credentials. Valid credential types include:
   * - OAuth access token
   * - Personal access token
   */
  getCredentials(): object {
    return this.credentials as unknown as object;
  }

  /**
   * The human readable account name (email address) to be displayed
   * to the user.
   */
  async getDisplayName(): Promise<string> {
    const response = await this.apiClient.getAccount();
    return response.email;
  }

  /**
   * An enum representing the status of the account.
   */
  async getStatus(): Promise<DigitalOceanStatus> {
    const response = await this.apiClient.getAccount();
    if (response.status === 'active') {
      return DigitalOceanStatus.ACTIVE;
    } else if (!response.email_verified) {
      return DigitalOceanStatus.EMAIL_NOT_VERIFIED;
    } else {
      return DigitalOceanStatus.INVALID_BILLING;
    }
  }

  /**
   * Returns a list of DigitalOceanLocation objects that support the
   * required cloud resources to setup an Outline server (e.g. Droplets,
   * Floating IPs).
   */
  async listLocations(): Promise<DigitalOceanLocation[]> {
    try {
      const regionInfos = await this.apiClient.getRegionInfo();
      const locations: DigitalOceanLocation[] = [];
      regionInfos.forEach((region) => {
        const regionId = GetCityId(region.slug);
        if (region.available && region.sizes.indexOf(MACHINE_SIZE) !== -1) {
          const location: DigitalOceanLocation =
              locations.find((entry) => entry.regionId === regionId);
          if (location) {
            location.dataCenterIds.push(region.slug);
          } else {
            const entry = {
              regionId: GetCityId(region.slug),
              dataCenterIds: [region.slug],
            };
            locations.push(entry);
          }
        }
      });
      return locations;
    } catch (error) {
      this.processError(error);
    }
  }

  /**
   * Creates an Outline server on DigitalOcean. The returned server will
   * not be fully initialized until ${@link DigitalOceanServer#waitOnInstall}
   * completes.
   *
   * @param name - The Outline server name.
   * @param location - The DigitalOcean data center location.
   */
  async createServer(name: string, location: DigitalOceanLocation): Promise<DigitalOceanServer> {
    console.time('activeServer');
    console.time('servingServer');
    const watchtowerRefreshSeconds = this.shadowboxSettings.containerImageId ? 30 : undefined;
    const installCommand = this.getInstallScript(
        this.apiClient.accessToken, name, this.shadowboxSettings.containerImageId,
        watchtowerRefreshSeconds, this.shadowboxSettings.metricsUrl,
        this.shadowboxSettings.sentryApiUrl);

    const dropletSpec = {
      installCommand,
      size: MACHINE_SIZE,
      image: 'docker-18-04',
      tags: [SHADOWBOX_TAG],
    };

    const keyPair = await crypto.generateKeyPair();
    if (this.shadowboxSettings.debug) {
      // Strip carriage returns, which produce weird blank lines when pasted into a terminal.
      console.debug(
          `private key for SSH access to new droplet:\n${keyPair.private.replace(/\r/g, '')}\n\n` +
          'Use "ssh -i keyfile root@[ip_address]" to connect to the machine');
    }

    try {
      const droplet =
          await this.apiClient.createDroplet(name, location.dataCenterIds[0], keyPair.public, dropletSpec);
      const server = new DigitalOceanServer(this.apiClient, droplet.droplet);
      this.servers.push(server);
      return server;
    } catch (error) {
      this.processError(error);
    }
  }

  /** Returns a list of Outline servers managed by the account. */
  async listServers(fetchFromHost = true): Promise<DigitalOceanServer[]> {
    if (!fetchFromHost) {
      return Promise.resolve(this.servers);  // Return the in-memory servers.
    }

    try {
      const droplets = await this.apiClient.getDropletsByTag(SHADOWBOX_TAG);
      this.servers = droplets.map((droplet) => new DigitalOceanServer(this.apiClient, droplet));
      return this.servers;
    } catch (error) {
      this.processError(error);
    }
  }

  /** Disconnects the DigitalOcean account and revokes credentials. */
  disconnect(): void {
    this.accountManager.remove(this.accountId);
  }

  // cloudFunctions needs to define cloud::public_ip and cloud::add_tag.
  private getInstallScript(
      accessToken: string, name: string, image?: string, watchtowerRefreshSeconds?: number,
      metricsUrl?: string, sentryApiUrl?: string): string {
    const sanitizedAccessToken = this.sanitizeDigitalOceanToken(accessToken);
    // TODO: consider shell escaping these variables.
    return '#!/bin/bash -eu\n' +
        `export DO_ACCESS_TOKEN=${sanitizedAccessToken}\n` +
        (image ? `export SB_IMAGE=${image}\n` : '') +
        (watchtowerRefreshSeconds ?
             `export WATCHTOWER_REFRESH_SECONDS=${watchtowerRefreshSeconds}\n` :
             '') +
        (sentryApiUrl ? `export SENTRY_API_URL="${sentryApiUrl}"\n` : '') +
        (metricsUrl ? `export SB_METRICS_URL=${metricsUrl}\n` : '') +
        `export SB_DEFAULT_SERVER_NAME="${name}"\n` + do_install_script.SCRIPT;
  }

  private sanitizeDigitalOceanToken(input: string): string {
    const sanitizedInput = input.trim();
    const pattern = /^[A-Za-z0-9_\/-]+$/;
    if (!pattern.test(sanitizedInput)) {
      throw new Error('Invalid DigitalOcean Token');
    }
    return sanitizedInput;
  }

  private processError(error: Error) {
    if (error instanceof HttpError) {
      if (error.getStatusCode() === 401) {
        this.domainEvents.emit(DigitalOceanAccount.EVENT_ACCOUNT_CONNECTIVITY_ISSUE);
      } else {
        console.error(`DigitalOcean API request failed with status 
              ${error.getStatusCode()} and message: ${error.getMessage()}`);
      }
    } else if (error instanceof NetworkError) {
      this.domainEvents.emit(DigitalOceanAccount.EVENT_ACCOUNT_CONNECTIVITY_ISSUE);
    } else {
      console.error(`DigitalOceanSession error: ${error.message}`);
    }
  }
}

export function GetCityId(slug: string): string {
  return slug.substr(0, 3).toLowerCase();
}
