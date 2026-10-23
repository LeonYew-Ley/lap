import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPhotoClusterIndex } from '../src/common/mapClusters.js'

test('cluster cover follows query rank across zoom levels and sorting changes', () => {
  const points = [
    { lat: 0, lon: 0, count: 10, file_id: 1, rank: 2, pointIds: [1] },
    { lat: 0, lon: 0.001, count: 1, file_id: 20, rank: 1, pointIds: [20] },
  ]
  const project = point => ({ x: point.lon, y: point.lat })
  for (const clusters of buildPhotoClusterIndex(points, project, 3).values()) {
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].file_id, 20)
    assert.equal(clusters[0].count, 11)
    assert.deepEqual(new Set(clusters[0].pointIds), new Set([1, 20]))
  }
  points[0].rank = 0
  for (const clusters of buildPhotoClusterIndex(points, project, 3).values()) {
    assert.equal(clusters[0].file_id, 1)
  }
})
