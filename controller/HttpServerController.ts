// Copyright (c) 2021. Heusala Group Oy <info@heusalagroup.fi>. All rights reserved.

import { IncomingMessage, ServerResponse } from "http";
import { Server as StaticServer } from 'node-static';
import { ResponseEntity } from "../../core/request/ResponseEntity";
import { LogService } from "../../core/LogService";
import { ReactServerController } from "./ReactServerController";
import { WELL_KNOWN_HG_HEALTH_CHECK_END_POINT } from "../../core/constants/wellKnown";
import { every, some, startsWith } from "../../core/modules/lodash";
import { createHealthCheckDTO } from "../../core/types/HealthCheckDTO";

const LOG = LogService.createLogger('HttpServerController');

export class HttpServerController {

    private readonly _appDir         : string;
    private readonly _fileServer     : StaticServer;
    private readonly _App            : any;
    private readonly _apiBasePath    : string | undefined;
    private readonly _apiUrl         : string | undefined;
    private readonly _proxy          : any    | undefined;
    private readonly _reactRouteList : readonly string[];

    /**
     *
     * @param appDir
     * @param App
     * @param apiUrl
     * @param reactRouteList This array should include any route that must be handler using SSR React.
     *                       Especially it should include the index.html file located inside the public folder, otherwise
     *                       it will be served directly using static router and SSR wouldn't work for the index page.
     */
    public constructor (
        appDir          : string,
        App             : any,
        apiUrl         ?: string,
        reactRouteList ?: readonly string[]
    ) {
        this._appDir     = appDir;
        this._App        = App;
        this._fileServer = new StaticServer(appDir);
        this._reactRouteList = reactRouteList ?? [];

        if (apiUrl !== undefined) {
            this._apiBasePath = '/api';
            this._apiUrl = apiUrl;
            const httpProxy = require('http-proxy');
            this._proxy = httpProxy.createProxyServer(
                {
                    autoRewrite: true,
                    proxyTimeout: 30*1000,
                    timeout: 30*1000
                }
            );
            LOG.info(`Enabled docroot "${this._appDir}" with "${this._apiBasePath}" passed to "${this._apiUrl}"`);
        } else {
            LOG.info(`Enabled docroot "${this._appDir}"`);
        }

    }

    public async handleRequest (
        req    : IncomingMessage,
        res    : ServerResponse,
    ) {
        let method = undefined;
        let url = undefined;
        try {
            method = req.method;
            url = req.url;
            if ( startsWith(url, WELL_KNOWN_HG_HEALTH_CHECK_END_POINT)) {
                LOG.debug(`Routing request "${method} ${url}" to local health check`);
                await this._waitUntilRequestEnd(req);
                await this._serveAsLocalHealthCheck(res, url, true);
            } else if ( this._isReactRoute(url) ) {
                LOG.debug(`Routing request "${method} ${url}" to ReactController`)
                await this._serveUsingReactController(res, url);
            } else if ( this._proxy && this._isApiRoute(url) ) {
                LOG.debug(`Routing request "${method} ${url}" to "${this._apiUrl}"`)
                await this._proxyRequestToTarget(req, res, this._apiUrl, this._apiBasePath);
            } else {
                LOG.debug(`Routing request "${method} ${url}" to static server`)
                await this._waitUntilRequestEnd(req);
                await this._serveUsingStaticServer(req, res);
            }
        } catch (err) {
            const statusCode = (err as any)?.status ?? -1;
            if ( statusCode === 404 ) {
                try {
                    LOG.debug(`"${method} ${url}": Not Found 404: Routing request to ReactController`);
                    await this._serveUsingReactController(res, url);
                } catch (err2) {
                    LOG.debug(`"${method} ${url}": Error in ReactController: `, err2);
                    HttpServerController._writeError(res, url, err2, 500, 'Internal Server Error');
                }
            } else {
                LOG.error(`"${method} ${url}": Error ${statusCode}: `, err);
                HttpServerController._writeError(res, url, err, statusCode, `Error ${statusCode}`);
            }
        } finally {
            if (!res.writableEnded) {
                LOG.warn(`"${method} ${url}": Warning! Request handler did not close the response.`);
                res.end();
            }
        }
    }

    private async _waitUntilRequestEnd (
        req    : IncomingMessage
    ) : Promise<void> {
        await new Promise( (resolve, reject) => {
            try {
                req.addListener('end', () => {
                    resolve(undefined);
                }).resume();
            } catch (err) {
                reject(err);
            }
        });
    }

    private async _serveUsingStaticServer (
        req : IncomingMessage,
        res : ServerResponse
    ) : Promise<void> {
        await new Promise( (resolve, reject) => {
            try {
                this._fileServer.serve(req, res, (err : Error) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(undefined);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    private async _serveUsingReactController (
        res : ServerResponse,
        url : string
    ) : Promise<void> {
        const response : ResponseEntity<string> = await ReactServerController.handleReactRequest(
            url,
            this._appDir,
            this._App
        );
        HttpServerController._writeResponseEntity(res, url, response);
    }

    /**
     *
     * @param res
     * @param url
     * @param isHealthy
     * @private
     * @fixme Call health check for proxy target
     */
    private async _serveAsLocalHealthCheck (
        res : ServerResponse,
        url : string,
        isHealthy: boolean
    ) : Promise<void> {
        HttpServerController._writeResponseEntity(res, url, ResponseEntity.ok<string>(JSON.stringify(createHealthCheckDTO(isHealthy))));
        return;
    }

    private static _writeResponseEntity (
        res      : ServerResponse,
        url      : string,
        response : ResponseEntity<any>
    ) {
        const statusCode = response.getStatusCode();
        LOG.info(`"${url}": ${statusCode}`);
        res.writeHead(statusCode);
        res.end(response.getBody());
    }

    private static _writeError (
        res        : ServerResponse,
        url        : string,
        err        : any,
        statusCode : number,
        body       : string
    ) {
        LOG.error(`ERROR: `, err);
        LOG.info(`"${url}": ${statusCode}`);
        res.writeHead(statusCode);
        res.end(body);
    }

    /**
     * Proxies the request to another address.
     *
     * Note! Call this method only from a code which tests that optional `this._proxy` exists.
     *
     * @param req
     * @param res
     * @param target Target to proxy the request
     * @param basePath Base path to strip from the request
     * @private
     */
    private async _proxyRequestToTarget (
        req      : IncomingMessage,
        res      : ServerResponse,
        target   : string,
        basePath : string
    ) : Promise<void> {

        return await new Promise( (resolve, reject) => {
            try {

                const url : string = `${req.url}`;
                req.url = url.startsWith(basePath) ? url.substring(basePath.length) : url;

                LOG.debug(`_proxyRequestToTarget: Routing "${req.url}" to "${target}"`)
                this._proxy.web(req, res, {target}, (err: Error) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });

            } catch (err) {
                reject(err);
            }
        });

    }

    /**
     *
     * @param url
     * @returns true if the route is API route and should be proxied
     * @private
     */
    private _isApiRoute (url: string) : boolean {
        return startsWith(url, this._apiBasePath);
    }

    /**
     *
     * @param url
     * @returns true if the route should be directed to the React SSR handler
     * @private
     */
    private _isReactRoute (url: string) : boolean {
        return some(
            this._reactRouteList,
            (route: string) : boolean => {
                const urlParts = url.split('/');
                const routeParts = route.split('/');
                if (urlParts.length !== routeParts.length) {
                    return false;
                }
                return every(
                    urlParts,
                    (part: string, index: number) : boolean => {
                        const routePart = routeParts[index];
                        return startsWith(routePart, ':') ? true : routePart === part;
                    }
                );
            }
        );
    }

}
