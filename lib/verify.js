'use strict'

const BB = require('bluebird')

const checksumStream = require('checksum-stream')
const contentPath = require('./content/path')
const finished = BB.promisify(require('mississippi').finished)
const fixOwner = require('./util/fix-owner')
const fs = require('graceful-fs')
const glob = BB.promisify(require('glob'))
const index = require('./entry-index')
const path = require('path')
const pipe = BB.promisify(require('mississippi').pipe)
const rimraf = BB.promisify(require('rimraf'))

BB.promisifyAll(fs)

module.exports = verify
function verify (cache, opts) {
  opts = opts || {}
  opts.log && opts.log.silly('verify', 'verifying cache at', cache)
  return BB.reduce([
    markStartTime,
    fixPerms,
    garbageCollect,
    rebuildIndex,
    cleanTmp,
    writeVerifile,
    markEndTime
  ], (stats, step, i) => {
    const label = step.name || `step #${i}`
    const start = new Date()
    return BB.resolve(step(cache, opts)).then(s => {
      s && Object.keys(s).forEach(k => {
        stats[k] = s[k]
      })
      const end = new Date()
      if (!stats.runTime) { stats.runTime = {} }
      stats.runTime[label] = end - start
      return stats
    })
  }, {}).tap(stats => {
    stats.runTime.total = stats.endTime - stats.startTime
    opts.log && opts.log.silly('verify', 'verification finished for', cache, 'in', `${stats.runTime.total}ms`)
  })
}

function markStartTime (cache, opts) {
  return { startTime: new Date() }
}

function markEndTime (cache, opts) {
  return { endTime: new Date() }
}

function fixPerms (cache, opts) {
  opts.log && opts.log.silly('verify', 'fixing cache permissions')
  return fixOwner.mkdirfix(cache, opts.uid, opts.gid).then(() => {
    // TODO - fix file permissions too
    return fixOwner.chownr(cache, opts.uid, opts.gid)
  }).then(() => null)
}

// Implements a naive mark-and-sweep tracing garbage collector.
//
// The algorithm is basically as follows:
// 1. Read (and filter) all index entries ("pointers")
// 2. Mark each algo/digest combo as "live"
// 3. Read entire filesystem tree in `content-vX/` dir
// 4. If content is live, verify its checksum and delete it if it fails
// 5. If content is not marked as live, rimraf it.
//
function garbageCollect (cache, opts) {
  opts.log && opts.log.silly('verify', 'garbage collecting content')
  const indexStream = index.lsStream(cache)
  const liveContent = new Set()
  indexStream.on('data', entry => {
    if (opts && opts.filter && !opts.filter(entry)) { return }
    liveContent.add(`${entry.hashAlgorithm}-${entry.digest}`)
  })
  return finished(indexStream).then(() => {
    const contentDir = contentPath._contentDir(cache)
    return glob(path.join(contentDir, '**'), {
      follow: false,
      nodir: true,
      nosort: true
    }).then(files => {
      return BB.resolve({
        verifiedContent: 0,
        reclaimedCount: 0,
        reclaimedSize: 0,
        badContentCount: 0,
        keptSize: 0
      }).tap((stats) => BB.map(files, (f) => {
        const split = f.split(/[/\\]/)
        const digest = split.slice(split.length - 3).join('')
        const algo = split[split.length - 4]
        if (liveContent.has(`${algo}-${digest}`)) {
          return verifyContent(f, digest, algo).then(info => {
            if (!info.valid) {
              stats.reclaimedCount++
              stats.badContentCount++
              stats.reclaimedSize += info.size
            } else {
              stats.verifiedContent++
              stats.keptSize += info.size
            }
            return stats
          })
        } else {
          // No entries refer to this content. We can delete.
          stats.reclaimedCount++
          return fs.statAsync(f).then(s => {
            return rimraf(f).then(() => {
              stats.reclaimedSize += s.size
              return stats
            })
          })
        }
      }, {concurrency: opts.concurrency || 20}))
    })
  })
}

function verifyContent (filepath, digest, algorithm) {
  return fs.statAsync(filepath).then(stat => {
    const reader = fs.createReadStream(filepath)
    const checksummer = checksumStream({digest, algorithm})
    const contentInfo = {
      size: stat.size,
      valid: true
    }
    checksummer.on('data', () => {})
    return pipe(reader, checksummer).catch({code: 'EBADCHECKSUM'}, () => {
      return rimraf(filepath).then(() => {
        contentInfo.valid = false
      })
    }).then(() => contentInfo)
  }).catch({code: 'ENOENT'}, () => ({size: 0, valid: false}))
}

function rebuildIndex (cache, opts) {
  opts.log && opts.log.silly('verify', 'rebuilding index')
  return index.ls(cache).then(entries => {
    const stats = {
      missingContent: 0,
      rejectedEntries: 0,
      totalEntries: 0
    }
    const buckets = {}
    for (let k in entries) {
      if (entries.hasOwnProperty(k)) {
        const hashed = index._hashKey(k)
        const entry = entries[k]
        const excluded = opts && opts.filter && !opts.filter(entry)
        excluded && stats.rejectedEntries++
        if (buckets[hashed] && !excluded) {
          buckets[hashed].push(entry)
        } else if (buckets[hashed] && excluded) {
          // skip
        } else if (excluded) {
          buckets[hashed] = []
          buckets[hashed]._path = index._bucketPath(cache, k)
        } else {
          buckets[hashed] = [entry]
          buckets[hashed]._path = index._bucketPath(cache, k)
        }
      }
    }
    return BB.map(Object.keys(buckets), key => {
      return rebuildBucket(cache, buckets[key], stats, opts)
    }, {concurrency: opts.concurrency || 20}).then(() => stats)
  })
}

function rebuildBucket (cache, bucket, stats, opts) {
  return fs.truncateAsync(bucket._path).then(() => {
    // This needs to be serialized because cacache explicitly
    // lets very racy bucket conflicts clobber each other.
    return BB.mapSeries(bucket, entry => {
      const content = contentPath(cache, entry.digest, entry.hashAlgorithm)
      return fs.statAsync(content).then(() => {
        return index.insert(cache, entry.key, entry.digest, {
          uid: opts.uid,
          gid: opts.gid,
          hashAlgorithm: entry.hashAlgorithm,
          metadata: entry.metadata
        }).then(() => { stats.totalEntries++ })
      }).catch({code: 'ENOENT'}, () => {
        stats.rejectedEntries++
        stats.missingContent++
      })
    })
  })
}

function cleanTmp (cache, opts) {
  opts.log && opts.log.silly('verify', 'cleaning tmp directory')
  return rimraf(path.join(cache, 'tmp'))
}

function writeVerifile (cache, opts) {
  const verifile = path.join(cache, '_lastverified')
  opts.log && opts.log.silly('verify', 'writing verifile to ' + verifile)
  return fs.writeFileAsync(verifile, '' + (+(new Date())))
}

module.exports.lastRun = lastRun
function lastRun (cache) {
  return fs.readFileAsync(
    path.join(cache, '_lastverified'), 'utf8'
  ).then(data => new Date(+data))
}
