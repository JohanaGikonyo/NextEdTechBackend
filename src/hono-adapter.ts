import { AbstractHttpAdapter } from '@nestjs/core';
import { Hono } from 'hono';

function createReq(c: any) {
  const req = c.req;
  return {
    method: req.method,
    url: req.url,
    path: req.path,
    headers: req.header,
    header: req.header,
    query: req.query(),
    params: req.param(),
    body: undefined as any,
    raw: c.req.raw,
    originalUrl: req.url,
    hostname: new URL(req.url).hostname,
    protocol: new URL(req.url).protocol.replace(':', ''),
    secure: new URL(req.url).protocol === 'https:',
    get: (name: string) => req.header(name),
  };
}

function createRes(c: any) {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let body: any = undefined;
  let sent = false;

  const res: any = {
    statusCode,
    headersSent: false,
    finished: false,
    status(code: number) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    getHeader(name: string) {
      return headers[name];
    },
    removeHeader(name: string) {
      delete headers[name];
    },
    json(data: any) {
      body = JSON.stringify(data);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      this.headersSent = true;
      this.finished = true;
      sent = true;
      return this;
    },
    send(data: any) {
      if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Uint8Array) {
        body = data;
      } else if (data === null || data === undefined) {
        body = '';
      } else {
        body = JSON.stringify(data);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      this.headersSent = true;
      this.finished = true;
      sent = true;
      return this;
    },
    end(data?: any) {
      if (data !== undefined) body = data;
      this.headersSent = true;
      this.finished = true;
      sent = true;
      return this;
    },
    redirect(status: number | string, url?: string) {
      if (typeof status === 'string') {
        url = status;
        statusCode = 302;
      } else {
        statusCode = status;
      }
      headers.Location = url || '';
      sent = true;
      this.headersSent = true;
      this.finished = true;
      return this;
    },
    get(name: string) {
      return headers[name];
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
    write() {
      return true;
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
      return this;
    },
    _toResponse(): Response {
      return c.body(body, statusCode, headers);
    },
    _sent: () => sent,
  };

  return res;
}

function wrapHandler(handler: any) {
  return async (c: any) => {
    const req = createReq(c);

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      try {
        req.body = await c.req.json();
      } catch {
        req.body = undefined;
      }
    }

    const res = createRes(c);
    let nextCalled = false;
    const next = (err?: any) => {
      nextCalled = true;
      if (err) console.error('Route error:', err);
    };

    try {
      await handler(req, res, next);
    } catch (err) {
      console.error('Handler error:', err);
      return c.json({ error: 'Internal Server Error', message: String(err) }, 500);
    }

    if (res._sent()) return res._toResponse();
    if (nextCalled) return c.notFound();
    return res._toResponse();
  };
}

export class HonoAdapter extends AbstractHttpAdapter {
  constructor() {
    super(new Hono());
  }

  listen(_port: any, ...args: any[]): any {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback();
    return this.getInstance();
  }

  async close(): Promise<void> {}

  initHttpServer(_options: any): void {}

  use(...args: any[]): void {
    this.getInstance().use(...args);
  }

  get(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().get(path, wrapHandler(handler || pathOrHandler));
  }

  post(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().post(path, wrapHandler(handler || pathOrHandler));
  }

  put(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().put(path, wrapHandler(handler || pathOrHandler));
  }

  patch(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().patch(path, wrapHandler(handler || pathOrHandler));
  }

  delete(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().delete(path, wrapHandler(handler || pathOrHandler));
  }

  all(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().all(path, wrapHandler(handler || pathOrHandler));
  }

  head(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().head(path, wrapHandler(handler || pathOrHandler));
  }

  options(pathOrHandler: any, handler?: any): void {
    const path = typeof pathOrHandler === 'string' ? pathOrHandler : '*';
    this.getInstance().options(path, wrapHandler(handler || pathOrHandler));
  }

  getRequest(context: any): any {
    return context?.req;
  }

  getResponse(context: any): any {
    return context?.res;
  }

  getRequestHostname(request: any): string {
    return request.hostname;
  }

  getRequestMethod(request: any): string {
    return request.method;
  }

  getRequestUrl(request: any): string {
    return request.url;
  }

  status(response: any, statusCode: number): any {
    return response.status(statusCode);
  }

  reply(response: any, body: any, statusCode?: number): any {
    if (statusCode !== undefined) response.status(statusCode);
    return typeof body === 'object' ? response.json(body) : response.send(body);
  }

  setHeader(response: any, name: string, value: string): void {
    response?.setHeader?.(name, value);
  }

  appendHeader(response: any, name: string, value: string): void {
    const current = response?.getHeader?.(name);
    response?.setHeader?.(name, current ? `${current}, ${value}` : value);
  }

  registerParserMiddleware(): void {}

  enableCors(): void {}

  createMiddlewareFactory(): (path: string, callback: Function) => any {
    return (path, callback) => this.getInstance().use(path, callback);
  }

  getType(): string {
    return 'hono';
  }

  applyVersionFilter(handler: Function): (req: any, res: any, next: () => void) => Function {
    return (_req: any, _res: any, _next: () => void) => handler;
  }

  getHeader(request: any, name: string): string | undefined {
    return request?.header?.(name);
  }

  setStatus(response: any, status: number): void {
    response?.status?.(status);
  }

  render(): void {
    throw new Error('View rendering is not supported on Workers');
  }

  useStaticAssets(): void {}

  setViewEngine(): void {}

  setBaseViewsDir(): void {}

  setErrorHandler(): void {}

  setNotFoundHandler(): void {}

  isHeadersSent(response: any): boolean {
    return response?.headersSent ?? false;
  }

  redirect(response: any, status: number, url: string): void {
    response?.redirect?.(status, url);
  }

  end(response: any, message?: string): void {
    response?.end?.(message);
  }
}
