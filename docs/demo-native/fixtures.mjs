// Browser-only fixtures. No native Lap commands or user files are accessed.
export const STORAGE_KEY = 'lap-web-demo-v1';
export const names = ['Winter visitors', 'Portrait in light', 'Sunday drive', 'Under the stars', 'Hilltop village', 'City after dark', 'Yellow scooter', 'Golden fields', 'Melk Abbey', 'Garden visitor', 'Alpine flight', 'Quiet morning', 'Golden hour', 'Winter lake', 'Flamingo', 'Bee eater', 'Mountain blue', 'Harbour lights', 'At the water', 'City garden'];
export function createState() {
  return {
    photos: names.map((name, i) => ({
      id: i + 1, name: `${name.replaceAll(' ', '_')}.${i === 8 ? 'dng' : 'jpg'}`,
      image: `thumbnails/${String(i + 1).padStart(2, '0')}.jpg`,
      thumbWidth: [155,65,169,63,152,156,74,169,156,113,207,164,170,62,152,187,219,147,207,169][i],
      thumbHeight: [98,97,98,97,98,97,113,111,113,114,109,105,104,107,104,103,104,103,109,111][i],
      type: i === 8 ? 'RAW' : 'JPEG', album: 1, folder: i < 10 ? 1 : 2,
      favorite: [0, 8, 10, 16].includes(i), rating: i % 4 === 0 ? 5 : i % 3 === 0 ? 3 : 0,
      culling: i % 5 === 0 ? 'pick' : i === 6 ? 'reject' : 'unreviewed',
      tags: i === 1 || i === 6 ? ['Portraits', 'Travel'] : i % 2 === 0 ? ['Nature', 'Travel'] : ['Landscape'],
      person: i === 1 || i === 6 ? 'Sophie' : '',
      location: ['Austria', 'Italy', 'Switzerland'][i % 3],
      camera: i % 2 ? 'Sony A7 IV' : 'Canon EOS R5',
      date: `202${i < 10 ? 4 : 5}-${String(1 + i % 9).padStart(2, '0')}-${String(10 + i % 18).padStart(2, '0')}`,
      size: (2.4 + i * .63).toFixed(2), width: 6000, height: 4000,
      rotation: 0, comment: '', deleted: false, collectionIds: i === 8 || i === 16 ? [1] : [],
    })),
    albums: [{ id: 1, name: 'Sample-Wikimedia', path: '/Pictures/Sample-Wikimedia' }],
    folders: [{ id: 1, album: 1, name: 'Travel 2024' }, { id: 2, album: 1, name: 'Nature 2025' }],
    collections: [{ id: 1, name: 'Travel picks' }, { id: 2, name: 'For printing' }],
  };
}
export function addDuplicateFixtures(state) {
  // 20 initial thumbnails/records; pairs 11/19 and 8/20 are deliberate copies.
  for (const [original, copy] of [[11, 19], [8, 20]]) {
    const a = state.photos.find(p => p.id === original), b = state.photos.find(p => p.id === copy);
    a.hash = b.hash = `demo-hash-${original}`;
    b.image = a.image;
    b.name = a.name.replace('.jpg', '_copy.jpg');
    b.size = a.size;
    b.width = a.width; b.height = a.height;
  }
  return state;
}
