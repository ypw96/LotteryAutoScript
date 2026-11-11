/**
 * @typedef {import("http").IncomingHttpHeaders} HttpHeaders 头部信息
 * 
 * @typedef {object} Respond 返回的响应
 * @property {HttpHeaders} headers 响应头
 * @property {string} [body] UTF8编码响应
 * @property {import("http").IncomingMessage} [resStream] 可读流式响应体
 * 
 * @callback SuccessCb 成功回调
 * @param {Respond} res
 * @returns {void}
 * @callback FailureCb 失败回调
 * @param {string} err
 * @returns {void}
 * 
 * @typedef RequestConfig
 * @property {number} [timeout] 超时
 * @property {number} [wait] 错误等待
 * @property {boolean} [retry] 是否重传
 * @property {boolean} [redirect] 是否重定向
 * @property {number} [retry_times] 重试次数
 * 
 * @typedef ProxyConfig
 * @property {string} url https?://{IP}:{PORT}
 * @property {[[string, string]]} auth_headers [[k,v],[k,v]]
 * 
 * @typedef {object} RequestOptions Http请求选项
 * @property {string} [method] 请求方法
 * @property {string} url 完整链接
 * @property {boolean} [stream] 是否流式数据
 * @property {RequestConfig} [config] 设置
 * @property {ProxyConfig} [proxy] HTTP代理 IP:PORT
 * @property {Object.<string, string|number>} [query] 查询选项
 * @property {Object.<string, string|number> | string} [contents] 内容
 * @property {HttpHeaders} [headers] 请求头
 * @property {SuccessCb} [success] 成功回调
 * @property {FailureCb} [failure] 失败回调
 */

const { request: http_request } = require('http');
const { HttpProxyAgent } = require('http-proxy-agent');
const { request: https_request } = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { stringify } = require('querystring');
const dns = require('dns');

/**不可达节点缓存: ip -> 过期时间戳 */
const unreachable_ips = new Map();
/**不可达节点缓存时长 */
const UNREACHABLE_TTL = 30 * 60 * 1000;

/**
 * 挑选可用地址
 * 域名解析出多个IP时优先排除近期连接失败的节点, 避免所有请求反复卡在同一个坏节点上
 * @param {string} hostname 域名
 * @param {number} index 轮换序号
 * @param {(ip?: string, family?: number) => void} cb
 * @returns {void}
 */
function pickAddress(hostname, index, cb) {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) return cb();
        const now = Date.now();
        const usable = addresses.filter(a => !(unreachable_ips.get(a.address) > now));
        const list = usable.length > 0 ? usable : addresses;
        const { address, family } = list[index % list.length];
        cb(address, family);
    });
}

/**默认编码 */
const DEFAULT_DECODE = 'utf8';
/**超时时间 */
const DEFAULT_TIMEOUT = 20000;
/**出错等待时间 */
const DEFAULT_WAIT = 10000;
/**默认重传 */
const DEFAULT_RETRY = true;
/**默认不重定向 */
const DEFAULT_REDIRECT = false;
/**错误尝试次数 */
const DEFAULT_RETRY_TIMES = 6;
/**Google Chrome */
const DEFAULT_UA = process.env.ACCOUNT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';
/**默认url编码 */
const DEFAULT_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
/**
 * @description 简化HTTP请求
 * @param {RequestOptions} detail
 * @returns {void}
 */
function send(detail) {
    detail = setDefault(detail);
    const { method, url, stream, config, proxy, query, contents, headers, success, failure } = detail;
    const { timeout, wait, retry, redirect, retry_times } = config;
    /**本次请求开始时间 仅用于失败日志诊断耗时 */
    const start_time = Date.now();
    const thisURL = new URL(url)
        , content = formatContents(headers['content-type'], contents)
        , request = (thisURL.protocol === 'https:') ? https_request : http_request;
    // 使用代理时由代理解析域名, 不做本地地址选择
    if (!proxy && detail.lookup_ip === undefined) {
        pickAddress(thisURL.hostname, detail.addr_index || 0, (ip, family) => {
            detail.lookup_ip = ip || '';
            detail.lookup_family = family || 4;
            send(detail);
        });
        return;
    }
    /**
     * @type {import("https").RequestOptions}
     */
    let options = {
        timeout,
        method: method.toUpperCase(),
        hostname: thisURL.hostname,
        port: thisURL.port,
        path: thisURL.pathname + thisURL.search + thisURL.hash,
        headers,
    };
    // 指定本次请求连接的IP
    if (detail.lookup_ip) {
        options.lookup = (hostname, lookup_options, callback) => {
            if (lookup_options && lookup_options.all) {
                return callback(null, [{ address: detail.lookup_ip, family: detail.lookup_family }]);
            }
            callback(null, detail.lookup_ip, detail.lookup_family);
        };
    }
    if (!headers['user-agent']) options.headers['user-agent'] = DEFAULT_UA;
    if (query) options.path += (thisURL.search ? '&' : '?') + stringify(query);
    if (content) {
        if (!headers['content-type']) options.headers['content-type'] = DEFAULT_CONTENT_TYPE;
        options.headers['content-length'] = Buffer.byteLength(content, 'utf-8').toString();
    }
    if (proxy) {
        options.agent = (thisURL.protocol === 'https:')
            ? new HttpsProxyAgent(proxy.url)
            : new HttpProxyAgent(proxy.url);
        for (const ah of proxy.auth_headers) {
            options.headers[ah[0]] = ah[1];
        }
        options.rejectUnauthorized = false;
    }
    const req = request(options, res => {
        let protodata = '';
        const { statusCode, headers } = res;
        if (redirect && ~~(statusCode / 100) === 3) {
            try {
                detail.url = new URL(headers.location).href;
            } catch (error) {
                detail.url = new URL(thisURL.origin + headers.location).href;
            }
            console.log(`[重定向]状态码:${statusCode} location:${detail.url}`);
            // 目标域名已变, 重新解析
            detail.lookup_ip = undefined;
            detail.addr_index = 0;
            send(detail);
            return;
        }
        if (stream) {
            success({ headers: headers, resStream: res });
        } else {
            res.setEncoding(DEFAULT_DECODE)
                .on('data', chunk => { protodata += chunk; })
                .on('error', async err => {
                    if (retry && retry_times) {
                        console.log(`[不期待响应]原因:${err.message} 尝试重新请求中...`);
                        await delay(wait);
                        detail.config.retry_times = retry_times - 1;
                        send(detail);
                    } else {
                        failure(`[响应错误]${err.message} 响应数据:\n${protodata}`);
                    }
                })
                .on('end', () => {
                    if (statusCode < 400) {
                        success({ headers: headers, body: protodata });
                    } else {
                        res.emit('error', new Error(`HTTP状态码: ${statusCode}`));
                    }
                });
        }
    });
    req.on('error', async err => {
        if (retry && retry_times) {
            console.log(`[请求失败]原因:${err.message} code:${err.code || 'none'} host:${thisURL.host} 耗时:${Date.now() - start_time}ms 尝试重新连接中...`);
            // 记录该节点不可达并轮换地址, 避免重试时继续卡在同一个坏节点
            if (detail.lookup_ip) {
                unreachable_ips.set(detail.lookup_ip, Date.now() + UNREACHABLE_TTL);
                detail.lookup_ip = undefined;
            }
            detail.addr_index = (detail.addr_index || 0) + 1;
            await delay(wait);
            detail.config.retry_times = retry_times - 1;
            send(detail);
        } else {
            failure(`[请求失败]: ${err.message}`);
        }
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end(content);
}

/**
 * 处理请求体
 * 默认url编码字符串
 * @private
 * @param {string} type 请求的内容格式
 * @param {object} contents 请求体
 * @returns {string} 格式化字符串
 */
function formatContents(type, contents) {
    if (/application\/json/i.test(type)) return JSON.stringify(contents);
    if (typeof contents === 'object') return stringify(contents);
    return contents;
}

/**
 * 设置默认
 * @param {RequestOptions} detail
 * @returns {RequestOptions}
 */
function setDefault(detail) {
    detail = {
        method: 'GET',
        stream: false,
        proxy: '',
        headers: {},
        success: (res) => { console.log(res.headers); },
        failure: (err) => { console.log(err); },
        ...detail
    };
    detail.config = {
        timeout: DEFAULT_TIMEOUT,
        wait: DEFAULT_WAIT,
        retry: DEFAULT_RETRY,
        redirect: DEFAULT_REDIRECT,
        retry_times: DEFAULT_RETRY_TIMES,
        ...detail.config
    };
    return detail;
}

/**
 * 延时函数
 * @param {number} time ms
 * @returns {Promise<void>}
 */
function delay(time) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}


module.exports = { send };