import { parquetWriteBuffer } from 'hyparquet-writer';
import * as hq from 'hyparquet';

const buf = parquetWriteBuffer({
  columnData: [
    { name: 'lat', data: [10, 10, 20, 20], type: 'DOUBLE' },
    { name: 'lon', data: [0, 1, 0, 1], type: 'DOUBLE' },
    { name: 'v',   data: [1, 2, 3, 4], type: 'DOUBLE' },
  ],
  kvMetadata: [{ key: 'geo', value: JSON.stringify({ version: '1.0.0' }) }],
  rowGroupSize: 2,
  statistics: true,
});

const meta = hq.parquetMetadata(buf);
console.log('row_groups', meta.row_groups.length);
const col0 = meta.row_groups[0].columns[0];
console.log('col path', col0.meta_data.path_in_schema);
console.log('stats', col0.meta_data.statistics);
console.log('offsets', {
  data_page_offset: col0.meta_data.data_page_offset,
  dictionary_page_offset: col0.meta_data.dictionary_page_offset,
  file_offset: col0.file_offset,
  total_compressed_size: col0.meta_data.total_compressed_size,
});
console.log('kv', meta.key_value_metadata);

const rows = await hq.parquetReadObjects({ file: buf, columns: ['lat', 'v'] });
console.log('projected rows', rows);
