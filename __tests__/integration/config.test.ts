import type { Logger } from '../../src'
import { type ClickHouseClient } from '../../src'
import { createTestClient, guid, retryOnFailure } from '../utils'
import type { RetryOnFailureOptions } from '../utils/retry'
import type { ErrorLogParams, LogParams } from '../../src/logger'
import { createSimpleTable } from './fixtures/simple_table'

describe('config', () => {
  let client: ClickHouseClient
  let logs: {
    message: string
    err?: Error
    args?: Record<string, unknown>
  }[] = []

  afterEach(async () => {
    await client.close()
    logs = []
  })

  it('should set request timeout with "request_timeout" setting', async () => {
    client = createTestClient({
      request_timeout: 100,
    })

    await expect(
      client.query({
        query: 'SELECT sleep(3)',
      })
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringMatching('Timeout error'),
      })
    )
  })

  it('should specify the default database name on creation', async () => {
    client = createTestClient({
      database: 'system',
    })
    const result = await client.query({
      query: 'SELECT * FROM numbers LIMIT 2',
      format: 'TabSeparated',
    })
    expect(await result.text()).toEqual('0\n1\n')
  })

  describe('Logger support', () => {
    const logLevelKey = 'CLICKHOUSE_LOG_LEVEL'
    let defaultLogLevel: string | undefined
    beforeEach(() => {
      defaultLogLevel = process.env[logLevelKey]
    })
    afterEach(() => {
      if (defaultLogLevel === undefined) {
        delete process.env[logLevelKey]
      } else {
        process.env[logLevelKey] = defaultLogLevel
      }
    })

    it('should use the default logger implementation', async () => {
      process.env[logLevelKey] = 'DEBUG'
      client = createTestClient()
      const consoleSpy = jest.spyOn(console, 'log')
      await client.ping()
      // logs[0] are about current log level
      expect(consoleSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('Got a response from ClickHouse'),
        expect.objectContaining({
          request_headers: {
            'user-agent': expect.any(String),
          },
          request_method: 'GET',
          request_params: '',
          request_path: '/ping',
          response_headers: expect.objectContaining({
            connection: expect.stringMatching(/Keep-Alive/i),
            'content-type': 'text/html; charset=UTF-8',
            'transfer-encoding': 'chunked',
          }),
          response_status: 200,
        })
      )
      expect(consoleSpy).toHaveBeenCalledTimes(1)
    })

    it('should provide a custom logger implementation', async () => {
      process.env[logLevelKey] = 'DEBUG'
      client = createTestClient({
        log: {
          LoggerClass: TestLogger,
        },
      })
      await client.ping()
      // logs[0] are about current log level
      expect(logs[1]).toEqual({
        module: 'Connection',
        message: 'Got a response from ClickHouse',
        args: expect.objectContaining({
          request_path: '/ping',
          request_method: 'GET',
        }),
      })
    })

    it('should provide a custom logger implementation (but logs are disabled)', async () => {
      process.env[logLevelKey] = 'OFF'
      client = createTestClient({
        log: {
          // enable: false,
          LoggerClass: TestLogger,
        },
      })
      await client.ping()
      expect(logs).toHaveLength(0)
    })
  })

  describe('max_open_connections', () => {
    let results: number[] = []
    afterEach(() => {
      results = []
    })

    const retryOpts: RetryOnFailureOptions = {
      maxAttempts: 20,
    }

    function select(query: string) {
      return client
        .query({
          query,
          format: 'JSONEachRow',
        })
        .then((r) => r.json<[{ x: number }]>())
        .then(([{ x }]) => results.push(x))
    }

    it('should use only one connection', async () => {
      client = createTestClient({
        max_open_connections: 1,
      })
      void select('SELECT 1 AS x, sleep(0.3)')
      void select('SELECT 2 AS x, sleep(0.3)')
      await retryOnFailure(async () => {
        expect(results).toEqual([1])
      }, retryOpts)
      await retryOnFailure(async () => {
        expect(results.sort()).toEqual([1, 2])
      }, retryOpts)
    })

    it('should use only one connection for insert', async () => {
      const tableName = `config_single_connection_insert_${guid()}`
      client = createTestClient({
        max_open_connections: 1,
        request_timeout: 3000,
      })
      await createSimpleTable(client, tableName)

      const timeout = setTimeout(() => {
        throw new Error('Timeout was triggered')
      }, 3000).unref()

      const value1 = { id: '42', name: 'hello', sku: [0, 1] }
      const value2 = { id: '43', name: 'hello', sku: [0, 1] }
      function insert(value: object) {
        return client.insert({
          table: tableName,
          values: [value],
          format: 'JSONEachRow',
        })
      }
      await insert(value1)
      await insert(value2) // if previous call holds the socket, the test will time out
      clearTimeout(timeout)

      const result = await client.query({
        query: `SELECT * FROM ${tableName}`,
        format: 'JSONEachRow',
      })

      const json = await result.json<object[]>()
      expect(json).toContainEqual(value1)
      expect(json).toContainEqual(value2)
      expect(json.length).toEqual(2)
    })

    it('should use several connections', async () => {
      client = createTestClient({
        max_open_connections: 2,
      })
      void select('SELECT 1 AS x, sleep(0.3)')
      void select('SELECT 2 AS x, sleep(0.3)')
      void select('SELECT 3 AS x, sleep(0.3)')
      void select('SELECT 4 AS x, sleep(0.3)')
      await retryOnFailure(async () => {
        expect(results).toContain(1)
        expect(results).toContain(2)
        expect(results.sort()).toEqual([1, 2])
      }, retryOpts)
      await retryOnFailure(async () => {
        expect(results).toContain(3)
        expect(results).toContain(4)
        expect(results.sort()).toEqual([1, 2, 3, 4])
      }, retryOpts)
    })
  })

  class TestLogger implements Logger {
    trace(params: LogParams) {
      logs.push(params)
    }
    debug(params: LogParams) {
      logs.push(params)
    }
    info(params: LogParams) {
      logs.push(params)
    }
    warn(params: LogParams) {
      logs.push(params)
    }
    error(params: ErrorLogParams) {
      logs.push(params)
    }
  }
})
