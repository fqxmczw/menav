const test = require('node:test');
const assert = require('node:assert/strict');

const { deployPages } = require('../scripts/deploy-pages.ts');

function makeEnv() {
  return {
    GITHUB_REPOSITORY: 'fixture/navigation',
    GITHUB_SHA: 'fixture-sha',
    PAGES_ARTIFACT_ID: '456',
    GITHUB_TOKEN: 'fixture-github-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-runtime-token',
  };
}

function makeFetch(responses) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const response = responses[Math.min(requests.length - 1, responses.length - 1)];
    return {
      ok: !response.status || (response.status >= 200 && response.status < 300),
      status: response.status || 200,
      json: async () => response.body,
    };
  };
  return { fetchImpl, requests };
}

test('Pages deployment：使用本次上传 ID 和 OIDC 直接发布，不再通过 Twirp 列举产物', async () => {
  const deployment = { id: 'deployment-123', page_url: 'https://example.test/navigation/' };
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: deployment },
    { body: { status: 'deployment_in_progress' } },
    { body: { status: 'succeed' } },
  ]);
  const delays = [];

  const result = await deployPages(makeEnv(), fetchImpl, async (delay) => delays.push(delay));

  assert.deepEqual(result, deployment);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, 'https://oidc.example.test/token');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-runtime-token');
  assert.equal(
    requests[1].url,
    'https://api.github.com/repos/fixture/navigation/pages/deployments'
  );
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer fixture-github-token');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    artifact_id: 456,
    pages_build_version: 'fixture-sha',
    oidc_token: 'fixture-oidc-token',
  });
  assert.equal(requests[2].url, `${requests[1].url}/deployment-123`);
  assert.ok(requests.every((request) => !request.url.includes('twirp')));
  assert.deepEqual(delays, [5000, 5000]);
});

test('Pages deployment：OIDC 响应无效时不得创建部署', async () => {
  const { fetchImpl, requests } = makeFetch([{ body: {} }]);

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async () => {}),
    /missing value/
  );
  assert.equal(requests.length, 1);
});

test('Pages deployment：通用失败终态后退避并重新发布同一产物，允许复用 SHA 部署 ID', async () => {
  const deployment = { id: 'fixture-sha', page_url: 'https://example.test/navigation/' };
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
    { body: deployment },
    { body: { status: 'succeed' } },
  ]);
  const delays = [];

  const result = await deployPages(makeEnv(), fetchImpl, async (delay) => delays.push(delay));

  assert.deepEqual(result, deployment);
  assert.equal(requests.length, 5);
  assert.equal(requests[3].options.method, 'POST');
  assert.equal(requests[3].url, requests[1].url);
  assert.deepEqual(JSON.parse(requests[3].options.body), JSON.parse(requests[1].options.body));
  assert.equal(requests[4].url, requests[2].url);
  assert.deepEqual(delays, [5000, 10000, 5000]);
});

test('Pages deployment：连续通用失败最多创建三次，不得无限重试或取消已终止部署', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
  ]);
  const delays = [];

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async (delay) => delays.push(delay)),
    /Pages deployment failed: deployment_failed/
  );
  assert.equal(requests.length, 7);
  assert.equal(requests.filter((request) => request.options.method === 'POST').length, 3);
  assert.ok(requests.every((request) => !request.url.endsWith('/cancel')));
  assert.deepEqual(delays, [5000, 10000, 5000, 20000, 5000]);
});

test('Pages deployment：多次创建共享总截止，退避耗尽时限后不得创建下一次部署', async () => {
  let clock = 0;
  let statusChecks = 0;
  const fixture = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
  ]);
  const fetchImpl = async (url, options) => {
    const response = await fixture.fetchImpl(url, options);
    if (options.method !== 'POST' && url.endsWith('/fixture-sha')) {
      statusChecks += 1;
      if (statusChecks === 1) clock += 570000;
    }
    return response;
  };
  const delays = [];

  await assert.rejects(
    deployPages(
      makeEnv(),
      fetchImpl,
      async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
      () => clock
    ),
    /10 minute total deadline/
  );
  assert.equal(clock, 600000);
  assert.equal(fixture.requests.length, 5);
  assert.deepEqual(delays, [5000, 10000, 5000, 10000]);
});

test('Pages deployment：退避中断后不得重新创建或取消已经失败的部署', async () => {
  const controller = new AbortController();
  const error = new Error('Fixture backoff interruption');
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
  ]);

  await assert.rejects(
    deployPages(
      makeEnv(),
      fetchImpl,
      async (milliseconds, signal) => {
        assert.equal(signal, controller.signal);
        if (milliseconds === 10000) controller.abort(error);
      },
      Date.now,
      controller.signal
    ),
    (actual) => actual === error
  );
  assert.equal(requests.length, 3);
});

test('Pages deployment：重新创建的 POST 失败时不得重试或取消旧的终态部署', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'fixture-sha' } },
    { body: { status: 'deployment_failed' } },
    { status: 503, body: {} },
  ]);

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async () => {}),
    /creation failed: HTTP 503/
  );
  assert.equal(requests.length, 4);
});

test('Pages deployment：重试后的状态读取失败只取消当前新部署', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'deployment-first' } },
    { body: { status: 'deployment_failed' } },
    { body: { id: 'deployment-second' } },
    { status: 503, body: {} },
    { status: 204 },
  ]);

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async () => {}),
    /status failed: HTTP 503/
  );
  assert.equal(requests.length, 6);
  assert.match(requests[5].url, /\/deployment-second\/cancel$/);
});

test('Pages deployment：创建请求失败时不盲目重试 POST', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { status: 403, body: { message: 'Forbidden' } },
  ]);

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async () => {}),
    /creation failed: HTTP 403/
  );
  assert.equal(requests.length, 2);
});

test('Pages deployment：永久失败状态必须使工作流失败', async () => {
  for (const status of [
    'deployment_content_failed',
    'deployment_perms_error',
    'deployment_cancelled',
    'deployment_lost',
  ]) {
    const { fetchImpl, requests } = makeFetch([
      { body: { value: 'fixture-oidc-token' } },
      { body: { id: 'deployment-123' } },
      { body: { status } },
    ]);

    await assert.rejects(
      deployPages(makeEnv(), fetchImpl, async () => {}),
      new RegExp(`Pages deployment failed: ${status}`)
    );
    assert.equal(requests.length, 3, `${status} must not be retried`);
  }
});

test('Pages deployment：状态读取异常时取消未完成部署并保留原错误', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'deployment-123' } },
    { status: 503, body: {} },
    { status: 204 },
  ]);

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async () => {}),
    /status failed: HTTP 503/
  );
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /\/deployment-123\/cancel$/);
  assert.equal(requests[3].options.method, 'POST');
});

test('Pages deployment：长时间无终态时有上限地取消并失败', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'deployment-123' } },
    { body: { status: 'deployment_in_progress' } },
  ]);
  const delays = [];

  await assert.rejects(
    deployPages(makeEnv(), fetchImpl, async (delay) => delays.push(delay)),
    /timed out after 120 status checks/
  );
  assert.equal(delays.length, 120);
  assert.equal(requests.length, 123);
  assert.match(requests[122].url, /\/cancel$/);
});

test('Pages deployment：未返回部署 ID 时按官方协议使用构建 SHA 查询', async () => {
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { page_url: 'https://example.test/navigation/' } },
    { body: { status: 'succeed' } },
  ]);

  await deployPages(makeEnv(), fetchImpl, async () => {});
  assert.match(requests[2].url, /\/fixture-sha$/);
});

test('Pages deployment：慢响应耗尽总时限时提前取消，不能等到 runner 硬超时', async () => {
  let clock = 0;
  const fixture = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'deployment-123' } },
    { body: { status: 'deployment_in_progress' } },
  ]);
  const fetchImpl = async (url, options) => {
    const response = await fixture.fetchImpl(url, options);
    if (url.endsWith('/deployment-123')) clock += 9000;
    return response;
  };

  await assert.rejects(
    deployPages(
      makeEnv(),
      fetchImpl,
      async (milliseconds) => {
        clock += milliseconds;
      },
      () => clock
    ),
    /10 minute total deadline/
  );
  assert.equal(fixture.requests.length, 46);
  assert.match(fixture.requests[45].url, /\/cancel$/);
});

test('Pages deployment：中断信号后取消部署，取消请求不能沿用已中断的 signal', async () => {
  const controller = new AbortController();
  const error = new Error('Fixture interruption');
  const { fetchImpl, requests } = makeFetch([
    { body: { value: 'fixture-oidc-token' } },
    { body: { id: 'deployment-123' } },
    { status: 204 },
  ]);

  await assert.rejects(
    deployPages(
      makeEnv(),
      fetchImpl,
      async () => controller.abort(error),
      Date.now,
      controller.signal
    ),
    (actual) => actual === error
  );
  assert.equal(requests.length, 3);
  assert.match(requests[2].url, /\/cancel$/);
  assert.equal(requests[2].options.signal.aborted, false);
});

test('Pages deployment：拒绝无效的上传产物 ID', async () => {
  const env = makeEnv();
  env.PAGES_ARTIFACT_ID = 'invalid';
  const { fetchImpl, requests } = makeFetch([]);

  await assert.rejects(
    deployPages(env, fetchImpl, async () => {}),
    /positive safe integer/
  );
  assert.equal(requests.length, 0);
});
