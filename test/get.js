'use strict'

const Buffer = require('safe-buffer').Buffer
const BB = require('bluebird')

const crypto = require('crypto')
const finished = BB.promisify(require('mississippi').finished)
const index = require('../lib/entry-index')
const memo = require('../lib/memoization')
const path = require('path')
const rimraf = BB.promisify(require('rimraf'))
const Tacks = require('tacks')
const test = require('tap').test
const testDir = require('./util/test-dir')(__filename)

const CacheContent = require('./util/cache-content')

const CACHE = path.join(testDir, 'cache')
const CONTENT = Buffer.from('foobarbaz', 'utf8')
const KEY = 'my-test-key'
const ALGO = 'sha512'
const DIGEST = crypto.createHash(ALGO).update(CONTENT).digest('hex')
const METADATA = { foo: 'bar' }

var get = require('..').get

// Simple wrapper util cause this gets WORDY
function streamGet (byDigest) {
  const args = [].slice.call(arguments, 1)
  let data = []
  let dataLen = 0
  let hashAlgorithm
  let digest
  let metadata
  const stream = (
    byDigest ? get.stream.byDigest : get.stream
  ).apply(null, args)
  stream.on('data', d => {
    data.push(d)
    dataLen += d.length
  }).on('hashAlgorithm', h => {
    hashAlgorithm = h
  }).on('digest', d => {
    digest = d
  }).on('metadata', m => {
    metadata = m
  })
  return finished(stream).then(() => ({
    data: Buffer.concat(data, dataLen), hashAlgorithm, digest, metadata
  }))
}

test('basic bulk get', t => {
  const fixture = new Tacks(CacheContent({
    [DIGEST]: CONTENT
  }, ALGO))
  fixture.create(CACHE)
  return index.insert(CACHE, KEY, DIGEST, {
    metadata: METADATA,
    hashAlgorithm: ALGO
  }).then(() => {
    return get(CACHE, KEY)
  }).then(res => {
    t.deepEqual(res, {
      metadata: METADATA,
      data: CONTENT,
      hashAlgorithm: ALGO,
      digest: DIGEST
    }, 'bulk key get returned proper data')
  }).then(() => {
    return get.byDigest(CACHE, DIGEST, {hashAlgorithm: ALGO})
  }).then(res => {
    t.deepEqual(res, CONTENT, 'byDigest returned proper data')
  })
})

test('basic stream get', t => {
  const fixture = new Tacks(CacheContent({
    [DIGEST]: CONTENT
  }, ALGO))
  fixture.create(CACHE)
  return index.insert(CACHE, KEY, DIGEST, {
    metadata: METADATA,
    hashAlgorithm: ALGO
  }).then(() => {
    return BB.join(
      streamGet(false, CACHE, KEY),
      streamGet(true, CACHE, DIGEST, { hashAlgorithm: ALGO }),
      (byKey, byDigest) => {
        t.deepEqual(byKey, {
          data: CONTENT,
          hashAlgorithm: ALGO,
          digest: DIGEST,
          metadata: METADATA
        }, 'got all expected data and fields from key fetch')
        t.deepEqual(
          byDigest.data,
          CONTENT,
          'got correct data from digest fetch'
        )
      }
    )
  })
})

test('ENOENT if not found', t => {
  return get(CACHE, KEY).then(() => {
    throw new Error('lookup should fail')
  }).catch(err => {
    t.ok(err, 'got an error')
    t.equal(err.code, 'ENOENT', 'error code is ENOENT')
    return get.info(CACHE, KEY)
  }).catch(err => {
    t.ok(err, 'got an error')
    t.equal(err.code, 'ENOENT', 'error code is ENOENT')
  })
})

test('get.info index entry lookup', t => {
  return index.insert(CACHE, KEY, DIGEST, {
    metadata: METADATA,
    hashAlgorithm: ALGO
  }).then(ENTRY => {
    return get.info(CACHE, KEY).then(entry => {
      t.deepEqual(entry, ENTRY, 'get.info() returned the right entry')
    })
  })
})

test('memoizes data on bulk read', t => {
  memo.clearMemoized()
  const fixture = new Tacks(CacheContent({
    [DIGEST]: CONTENT
  }, ALGO))
  fixture.create(CACHE)
  return index.insert(CACHE, KEY, DIGEST, {
    metadata: METADATA,
    hashAlgorithm: ALGO
  }).then(ENTRY => {
    return get(CACHE, KEY).then(() => {
      t.deepEqual(memo.get(CACHE, KEY), null, 'no memoization!')
      return get(CACHE, KEY, { memoize: true })
    }).then(res => {
      t.deepEqual(res, {
        metadata: METADATA,
        data: CONTENT,
        hashAlgorithm: ALGO,
        digest: DIGEST
      }, 'usual data returned')
      t.deepEqual(memo.get(CACHE, KEY), {
        entry: ENTRY,
        data: CONTENT
      }, 'data inserted into memoization cache')
      return rimraf(CACHE)
    }).then(() => {
      return get(CACHE, KEY)
    }).then(res => {
      t.deepEqual(res, {
        metadata: METADATA,
        data: CONTENT,
        hashAlgorithm: ALGO,
        digest: DIGEST
      }, 'memoized data fetched by default')
      return get(CACHE, KEY, { memoize: false }).then(() => {
        throw new Error('expected get to fail')
      }).catch(err => {
        t.ok(err, 'got an error from unmemoized get')
        t.equal(err.code, 'ENOENT', 'cached content not found')
        t.deepEqual(memo.get(CACHE, KEY), {
          entry: ENTRY,
          data: CONTENT
        }, 'data still in memoization cache')
      })
    })
  })
})

test('memoizes data on stream read', t => {
  memo.clearMemoized()
  const fixture = new Tacks(CacheContent({
    [DIGEST]: CONTENT
  }, ALGO))
  fixture.create(CACHE)
  return index.insert(CACHE, KEY, DIGEST, {
    metadata: METADATA,
    hashAlgorithm: ALGO
  }).then(ENTRY => {
    return BB.join(
      streamGet(false, CACHE, KEY),
      streamGet(true, CACHE, DIGEST, { hashAlgorithm: ALGO }),
      () => {
        t.deepEqual(memo.get(CACHE, KEY), null, 'no memoization by key!')
        t.deepEqual(
          memo.get.byDigest(CACHE, DIGEST, ALGO),
          null,
          'no memoization by digest!'
        )
      }
    ).then(() => {
      memo.clearMemoized()
      return streamGet(true, CACHE, DIGEST, {
        memoize: true,
        hashAlgorithm: ALGO
      })
    }).then(byDigest => {
      t.deepEqual(byDigest.data, CONTENT, 'usual data returned from stream')
      t.deepEqual(memo.get(CACHE, KEY), null, 'digest fetch = no key entry')
      t.deepEqual(
        memo.get.byDigest(CACHE, DIGEST, ALGO),
        CONTENT,
        'content memoized'
      )
      t.deepEqual(
        memo.get.byDigest(CACHE, DIGEST, 'sha1'),
        null,
        'content memoization filtered by hashAlgo'
      )
      t.deepEqual(
        memo.get.byDigest('whatev', DIGEST, ALGO),
        null,
        'content memoization filtered by cache'
      )
    }).then(() => {
      memo.clearMemoized()
      return streamGet(false, CACHE, KEY, { memoize: true })
    }).then(byKey => {
      t.deepEqual(byKey, {
        metadata: METADATA,
        data: CONTENT,
        hashAlgorithm: ALGO,
        digest: DIGEST
      }, 'usual data returned from key fetch')
      t.deepEqual(memo.get(CACHE, KEY), {
        entry: ENTRY,
        data: CONTENT
      }, 'data inserted into memoization cache')
      t.deepEqual(
        memo.get.byDigest(CACHE, DIGEST, ALGO),
        CONTENT,
        'content memoized by digest, too'
      )
      t.deepEqual(
        memo.get('whatev', KEY),
        null,
        'entry memoization filtered by cache'
      )
    }).then(() => {
      return rimraf(CACHE)
    }).then(() => {
      return BB.join(
        streamGet(false, CACHE, KEY),
        streamGet(true, CACHE, DIGEST, { hashAlgorithm: ALGO }),
        (byKey, byDigest) => {
          t.deepEqual(byKey, {
            metadata: METADATA,
            data: CONTENT,
            hashAlgorithm: ALGO,
            digest: DIGEST
          }, 'key fetch fulfilled by memoization cache')
          t.deepEqual(
            byDigest.data,
            CONTENT,
            'digest fetch fulfilled by memoization cache'
          )
        }
      )
    }).then(() => {
      return BB.join(
        streamGet(false, CACHE, KEY, {
          memoize: false
        }).catch(err => err),
        streamGet(true, CACHE, DIGEST, {
          hashAlgorithm: ALGO,
          memoize: false
        }).catch(err => err),
        (keyErr, digestErr) => {
          t.equal(keyErr.code, 'ENOENT', 'key get memoization bypassed')
          t.equal(keyErr.code, 'ENOENT', 'digest get memoization bypassed')
        }
      )
    })
  })
})

test('get.info uses memoized data', t => {
  memo.clearMemoized()
  const ENTRY = {
    key: KEY,
    digest: DIGEST,
    hashAlgorithm: ALGO,
    time: +(new Date()),
    metadata: null
  }
  memo.put(CACHE, ENTRY, CONTENT)
  return get.info(CACHE, KEY).then(info => {
    t.deepEqual(info, ENTRY, 'got the entry from memoization cache')
  })
})

test('identical hashes with different algorithms do not conflict')
test('throw error if something is really wrong with bucket')
