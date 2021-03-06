/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

// tslint:disable-next-line:max-line-length
import {BackendTimingInfo, DataType, fill, KernelBackend, ones, Rank, rsqrt, scalar, ShapeMap, Tensor, Tensor1D, tensor1d, Tensor2D, tensor2d, Tensor3D, tensor3d, Tensor4D} from '@tensorflow/tfjs-core';
import {Conv2DInfo} from '@tensorflow/tfjs-core/dist/ops/conv_util';
import {upcastType} from '@tensorflow/tfjs-core/dist/types';
import {isNullOrUndefined} from 'util';

// tslint:disable-next-line:max-line-length
import {createTensorsTypeOpAttr, createTypeOpAttr, getTFDType} from './ops/op_utils';
import {TensorMetadata, TFEOpAttr, TFJSBinding} from './tfjs_binding';

type TensorInfo = {
  shape: number[],
  dtype: number,
  values: Float32Array|Int32Array|Uint8Array,
  id: number
};

interface DataId {}

export class NodeJSKernelBackend implements KernelBackend {
  binding: TFJSBinding;
  private tensorMap = new WeakMap<DataId, TensorInfo>();

  constructor(binding: TFJSBinding) {
    this.binding = binding;
  }

  // Creates a new Tensor and maps the dataId to the passed in ID.
  private createOutputTensor(metadata: TensorMetadata): Tensor {
    const newId = {};

    this.tensorMap.set(newId, {
      shape: metadata.shape,
      dtype: metadata.dtype,
      id: metadata.id,
      values: null
    });

    let dtype: DataType;
    switch (metadata.dtype) {
      case this.binding.TF_FLOAT:
        dtype = 'float32';
        break;
      case this.binding.TF_INT32:
        dtype = 'int32';
        break;
      case this.binding.TF_BOOL:
        dtype = 'bool';
        break;
      case this.binding.TF_COMPLEX64:
        dtype = 'complex64';
        break;
      default:
        throw new Error(`Unknown dtype enum ${metadata.dtype}`);
    }
    return Tensor.make(metadata.shape, {dataId: newId}, dtype);
  }

  // Prepares Tensor instances for Op execution.
  private getInputTensorIds(tensors: Tensor[]): number[] {
    const ids: number[] = [];
    for (let i = 0; i < tensors.length; i++) {
      const info = this.tensorMap.get(tensors[i].dataId);
      // TODO - what about ID in this case? Handle in write()??
      if (info.values != null) {
        // Values were delayed to write into the TensorHandle. Do that before Op
        // execution and clear stored values.
        info.id =
            this.binding.createTensor(info.shape, info.dtype, info.values);
        info.values = null;
        this.tensorMap.set(tensors[i].dataId, info);
      }
      ids.push(info.id);
    }
    return ids;
  }

  private createReductionOpAttrs(tensor: Tensor): TFEOpAttr[] {
    return [
      {name: 'keep_dims', type: this.binding.TF_ATTR_BOOL, value: false},
      createTypeOpAttr('T', tensor.dtype), createTypeOpAttr('Tidx', 'int32')
    ];
  }

  private executeSingleInput(name: string, input: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', input.dtype)];
    return this.executeSingleOutput(name, opAttrs, [input]);
  }

  floatPrecision(): number {
    return 32;
  }

  /**
   * Executes a TensorFlow Eager Op that provides one output Tensor.
   * @param name The name of the Op to execute.
   * @param opAttrs The list of Op attributes required to execute.
   * @param inputs The list of input Tensors for the Op.
   * @return A resulting Tensor from Op execution.
   */
  executeSingleOutput(name: string, opAttrs: TFEOpAttr[], inputs: Tensor[]):
      Tensor {
    const outputMetadata = this.binding.executeOp(
        name, opAttrs, this.getInputTensorIds(inputs), 1);
    return this.createOutputTensor(outputMetadata[0]);
  }

  /**
   * Executes a TensorFlow Eager Op that provides multiple output Tensors.
   * @param name The name of the Op to execute.
   * @param opAttrs The list of Op attributes required to execute.
   * @param inputs The list of input Tensors for the Op.
   * @param numOutputs The number of output Tensors for Op execution.
   * @return A resulting Tensor array from Op execution.
   */
  executeMultipleOutputs(
      name: string, opAttrs: TFEOpAttr[], inputs: Tensor[],
      numOutputs: number): Tensor[] {
    const outputMetadata = this.binding.executeOp(
        name, opAttrs, this.getInputTensorIds(inputs), numOutputs);
    return outputMetadata.map(m => this.createOutputTensor(m));
  }

  dispose(): void {}

  async read(dataId: object): Promise<Float32Array|Int32Array|Uint8Array> {
    return this.readSync(dataId);
  }

  readSync(dataId: object): Float32Array|Int32Array|Uint8Array {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }
    const info = this.tensorMap.get(dataId);
    if (info.values != null) {
      return info.values;
    } else {
      return this.binding.tensorDataSync(info.id);
    }
  }

  disposeData(dataId: object): void {
    const id = this.tensorMap.get(dataId).id;
    if (id != null && id >= 0) {
      this.binding.deleteTensor(id);
    }
    this.tensorMap.delete(dataId);
  }

  write(dataId: object, values: Float32Array|Int32Array|Uint8Array): void {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }

    const info = this.tensorMap.get(dataId);
    info.values = values;
    this.tensorMap.set(dataId, info);
  }

  register(dataId: object, shape: number[], dtype: DataType): void {
    if (!this.tensorMap.has(dataId)) {
      this.tensorMap.set(
          dataId, {shape, dtype: getTFDType(dtype), values: null, id: -1});
    }
  }

  stridedSlice<T extends Tensor>(
      x: T, begin: number[], end: number[], strides: number[],
      beginMask: number, endMask: number, ellipsisMask: number,
      newAxisMask: number, shrinkAxisMask: number): T {
    const beginTensor = tensor1d(begin, 'int32');
    const endTensor = tensor1d(end, 'int32');
    const stridesTensor = tensor1d(strides, 'int32');
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Index', 'int32'),
      {name: 'begin_mask', type: this.binding.TF_ATTR_INT, value: beginMask},
      {name: 'end_mask', type: this.binding.TF_ATTR_INT, value: endMask}, {
        name: 'ellipsis_mask',
        type: this.binding.TF_ATTR_INT,
        value: ellipsisMask
      },
      {
        name: 'new_axis_mask',
        type: this.binding.TF_ATTR_INT,
        value: newAxisMask
      },
      {
        name: 'shrink_axis_mask',
        type: this.binding.TF_ATTR_INT,
        value: shrinkAxisMask
      }
    ];
    return this.executeSingleOutput(
               'StridedSlice', opAttrs,
               [x, beginTensor, endTensor, stridesTensor]) as T;
  }

  batchMatMul(
      a: Tensor<Rank.R3>, b: Tensor<Rank.R3>, transposeA: boolean,
      transposeB: boolean): Tensor<Rank.R3> {
    const opAttrs = [
      createTypeOpAttr('T', a.dtype),
      {name: 'adj_x', type: this.binding.TF_ATTR_BOOL, value: transposeA},
      {name: 'adj_y', type: this.binding.TF_ATTR_BOOL, value: transposeB}
    ];
    return this.executeSingleOutput('BatchMatMul', opAttrs, [a, b]) as
        Tensor<Rank.R3>;
  }

  slice<T extends Tensor>(x: T, begin: number[], size: number[]): T {
    const opAttrs =
        [createTypeOpAttr('T', x.dtype), createTypeOpAttr('Index', 'int32')];

    // Bind tensor values
    const beginTensor = tensor1d(begin, 'int32');
    const sizeTensor = tensor1d(size, 'int32');

    return this.executeSingleOutput(
               'Slice', opAttrs, [x, beginTensor, sizeTensor]) as T;
  }

  reverse<T extends Tensor>(a: T, axis: number[]): T {
    const opAttrs =
        [createTypeOpAttr('Tidx', 'int32'), createTypeOpAttr('T', a.dtype)];
    const axisTensor = tensor1d(axis, 'int32');
    return this.executeSingleOutput('ReverseV2', opAttrs, [a, axisTensor]) as T;
  }

  concat(tensors: Tensor[], axis: number): Tensor {
    const opAttrs = [
      {name: 'N', type: this.binding.TF_ATTR_INT, value: tensors.length}, {
        name: 'Tidx',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_INT32
      },
      createTensorsTypeOpAttr('T', tensors)
    ];

    const inputs = Array.from(tensors);
    inputs.push(scalar(axis, 'int32'));
    return this.executeSingleOutput('ConcatV2', opAttrs, inputs);
  }

  neg<T extends Tensor>(a: T): T {
    return this.executeSingleInput('Neg', a) as T;
  }

  add(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Add', opAttrs, [a, b]);
  }

  select(condition: Tensor, a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Select', opAttrs, [condition, a, b]);
  }

  addN<T extends Tensor>(tensors: T[]): T {
    const opAttrs = [
      createTypeOpAttr('T', tensors[0].dtype),
      {name: 'N', type: this.binding.TF_ATTR_INT, value: tensors.length}
    ];
    return this.executeSingleOutput('AddN', opAttrs, tensors) as T;
  }

  subtract(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Sub', opAttrs, [a, b]);
  }

  multiply(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Mul', opAttrs, [a, b]);
  }

  realDivide(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('RealDiv', opAttrs, [a, b]);
  }

  floorDiv(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('FloorDiv', opAttrs, [a, b]);
  }

  divide(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Div', opAttrs, [a, b]);
  }

  unsortedSegmentSum<T extends Tensor>(
      x: T, segmentIds: Tensor1D, numSegments: number): Tensor {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tindices', 'int32'),
      createTypeOpAttr('Tnumsegments', 'int32')
    ];
    return this.executeSingleOutput(
        'UnsortedSegmentSum', opAttrs,
        [x, segmentIds, scalar(numSegments, 'int32')]);
  }

  sum(x: Tensor, axes: number[]): Tensor {
    const axisTensor = tensor1d(axes, 'int32');
    return this.executeSingleOutput(
        'Sum', this.createReductionOpAttrs(x), [x, axisTensor]);
  }

  argMin(x: Tensor, axis: number): Tensor {
    const xInput = x.dtype === 'bool' ? x.toInt() : x;
    const axisScalar = scalar(axis, 'int32');
    const opAttrs = [
      createTypeOpAttr('T', xInput.dtype), createTypeOpAttr('Tidx', 'int32'),
      createTypeOpAttr('output_type', 'int32')
    ];
    return this.executeSingleOutput('ArgMin', opAttrs, [xInput, axisScalar]);
  }

  argMax(x: Tensor, axis: number): Tensor {
    const xInput = x.dtype === 'bool' ? x.toInt() : x;
    const axisScalar = scalar(axis, 'int32');
    const opAttrs = [
      createTypeOpAttr('T', xInput.dtype), createTypeOpAttr('Tidx', 'int32'),
      createTypeOpAttr('output_type', 'int32')
    ];
    return this.executeSingleOutput('ArgMax', opAttrs, [xInput, axisScalar]);
  }

  equal(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Equal', opAttrs, [a, b]);
  }

  notEqual(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('NotEqual', opAttrs, [a, b]);
  }

  less(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Less', opAttrs, [a, b]);
  }

  lessEqual(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('LessEqual', opAttrs, [a, b]);
  }

  greater(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Greater', opAttrs, [a, b]);
  }

  greaterEqual(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('GreaterEqual', opAttrs, [a, b]);
  }

  logicalNot<T extends Tensor>(a: T): T {
    return this.executeSingleOutput('LogicalNot', [], [a]) as T;
  }

  logicalAnd(a: Tensor, b: Tensor): Tensor {
    return this.executeSingleOutput('LogicalAnd', [], [a, b]);
  }

  logicalOr(a: Tensor, b: Tensor): Tensor {
    return this.executeSingleOutput('LogicalOr', [], [a, b]);
  }

  where(condition: Tensor): Tensor2D {
    return this.executeSingleOutput('Where', [], [condition]) as Tensor2D;
  }

  topKValues<T extends Tensor>(x: T, k: number): Tensor1D {
    throw new Error('Method not implemented.');
  }

  topKIndices(x: Tensor, k: number): Tensor1D {
    throw new Error('Method not implemented.');
  }

  topk<T extends Tensor>(x: T, k?: number, sorted?: boolean): [T, T] {
    const kCount = isNullOrUndefined(k) ? 1 : k;
    const isSorted = isNullOrUndefined(sorted) ? true : sorted;
    const opAttrs = [
      {name: 'sorted', type: this.binding.TF_ATTR_BOOL, value: isSorted},
      createTypeOpAttr('T', x.dtype),
    ];
    const kTensor = scalar(kCount, 'int32');

    // 'TopKV2' has two-hard coded output attributes:
    return this.executeMultipleOutputs(
               'TopKV2', opAttrs, [x, kTensor], 2) as [T, T];
  }

  min(x: Tensor, axes: number[]): Tensor {
    const axesTensor = tensor1d(axes, 'int32');
    return this.executeSingleOutput(
        'Min', this.createReductionOpAttrs(x), [x, axesTensor]);
  }

  minimum(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Minimum', opAttrs, [a, b]);
  }

  max(x: Tensor, axes: number[]): Tensor {
    const axesTensor = tensor1d(axes, 'int32');
    return this.executeSingleOutput(
        'Max', this.createReductionOpAttrs(x), [x, axesTensor]);
  }

  maximum(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', upcastType(a.dtype, b.dtype))];
    return this.executeSingleOutput('Maximum', opAttrs, [a, b]);
  }

  all(x: Tensor, axes: number[]): Tensor {
    const opAttrs = [
      {name: 'keep_dims', type: this.binding.TF_ATTR_BOOL, value: false},
      createTypeOpAttr('Tidx', 'int32')
    ];
    const axesTensor = tensor1d(axes, 'int32');
    return this.executeSingleOutput('All', opAttrs, [x, axesTensor]);
  }

  any(x: Tensor, axes: number[]): Tensor {
    const opAttrs = [
      {name: 'keep_dims', type: this.binding.TF_ATTR_BOOL, value: false},
      createTypeOpAttr('Tidx', 'int32')
    ];
    const axesTensor = tensor1d(axes, 'int32');
    return this.executeSingleOutput('Any', opAttrs, [x, axesTensor]);
  }

  ceil<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Ceil', x) as T;
  }

  floor<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Floor', x) as T;
  }

  pow<T extends Tensor>(a: T, b: Tensor): T {
    const dtype = upcastType(a.dtype, b.dtype);
    const opAttrs = [createTypeOpAttr('T', dtype)];
    return this.executeSingleOutput(
               'Pow', opAttrs, [a.cast(dtype), b.cast(dtype)]) as T;
  }

  exp<T extends Tensor>(x: T): T {
    const xTensor = x.dtype === 'int32' ? x.toFloat() : x;
    return this.executeSingleInput('Exp', xTensor) as T;
  }

  log<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Log', x) as T;
  }

  log1p<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Log1p', x) as T;
  }

  sqrt<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Sqrt', x) as T;
  }

  square<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Square', x) as T;
  }

  relu<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Relu', x) as T;
  }

  elu<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Elu', x) as T;
  }

  eluDer<T extends Tensor>(dy: T, y: T): T {
    const opAttrs = [createTypeOpAttr('T', y.dtype)];
    return this.executeSingleOutput('EluGrad', opAttrs, [dy, y]) as T;
  }

  selu<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Selu', x) as T;
  }

  int<T extends Tensor>(x: T): T {
    throw new Error('Method not implemented.');
  }

  clip<T extends Tensor>(x: T, min: number, max: number): T {
    const xMin = this.minimum(x, scalar(max));
    return this.maximum(xMin, scalar(min)) as T;
  }

  abs<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Abs', x) as T;
  }

  sigmoid<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Sigmoid', x) as T;
  }

  sin<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Sin', x) as T;
  }

  cos<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Cos', x) as T;
  }

  tan<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Tan', x) as T;
  }

  asin<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Asin', x) as T;
  }

  acos<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Acos', x) as T;
  }

  atan<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Atan', x) as T;
  }

  sinh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Sinh', x) as T;
  }

  cosh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Cosh', x) as T;
  }

  tanh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Tanh', x) as T;
  }

  mod(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', a.dtype)];
    return this.executeSingleOutput('FloorMod', opAttrs, [a, b]);
  }
  round<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Round', x) as T;
  }
  sign<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Sign', x) as T;
  }
  rsqrt<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Rsqrt', x) as T;
  }
  reciprocal<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Reciprocal', x) as T;
  }
  asinh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Asinh', x) as T;
  }
  acosh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Acosh', x) as T;
  }
  atanh<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Atanh', x) as T;
  }

  erf<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Erf', x) as T;
  }

  squaredDifference(a: Tensor, b: Tensor): Tensor {
    const opAttrs = [createTypeOpAttr('T', a.dtype)];
    return this.executeSingleOutput('SquaredDifference', opAttrs, [a, b]);
  }

  expm1<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Expm1', x) as T;
  }

  softplus<T extends Tensor>(x: T): T {
    return this.executeSingleInput('Softplus', x) as T;
  }

  atan2<T extends Tensor>(a: T, b: T): T {
    const opAttrs = [createTypeOpAttr('T', a.dtype)];
    return this.executeSingleOutput('Atan2', opAttrs, [a, b]) as T;
  }

  step<T extends Tensor>(x: T, alpha: number): T {
    const dtype = x.dtype;
    const nans = this.isNaN(x);
    const stepNoNans = this.select(
        this.greater(x, scalar(0, dtype)), ones(x.shape),
        fill(x.shape, alpha, dtype));
    return this.select(nans, x, stepNoNans) as T;
  }

  conv2d(x: Tensor4D, filter: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding},
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'use_cudnn_on_gpu', type: this.binding.TF_ATTR_BOOL, value: true},
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations},
    ];
    return this.executeSingleOutput('Conv2D', opAttrs, [x, filter]) as Tensor4D;
  }

  conv2dDerInput(dy: Tensor4D, filter: Tensor4D, convInfo: Conv2DInfo):
      Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', 'float32'),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'use_cudnn_on_gpu', type: this.binding.TF_ATTR_BOOL, value: true},
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations}
    ];
    const inputSizes = tensor1d(convInfo.inShape, 'int32');
    return this.executeSingleOutput(
               'Conv2DBackpropInput', opAttrs, [inputSizes, filter, dy]) as
        Tensor4D;
  }

  conv2dDerFilter(x: Tensor4D, dy: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', 'float32'),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'use_cudnn_on_gpu', type: this.binding.TF_ATTR_BOOL, value: true},
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations}
    ];
    const filterSizes = tensor1d(convInfo.filterShape, 'int32');
    return this.executeSingleOutput(
               'Conv2DBackpropFilter', opAttrs, [x, filterSizes, dy]) as
        Tensor4D;
  }

  depthwiseConv2DDerInput(dy: Tensor4D, filter: Tensor4D, convInfo: Conv2DInfo):
      Tensor4D {
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', 'float32'),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations}
    ];

    const inputSizes = tensor1d(convInfo.inShape, 'int32');
    return this.executeSingleOutput(
               'DepthwiseConv2dNativeBackpropInput', opAttrs,
               [inputSizes, filter, dy]) as Tensor4D;
  }

  depthwiseConv2DDerFilter(x: Tensor4D, dY: Tensor4D, convInfo: Conv2DInfo):
      Tensor4D {
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', 'float32'),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations}
    ];
    const filterSizes = tensor1d(convInfo.filterShape, 'int32');
    return this.executeSingleOutput(
               'DepthwiseConv2dNativeBackpropFilter', opAttrs,
               [x, filterSizes, dY]) as Tensor4D;
  }

  depthwiseConv2D(input: Tensor4D, filter: Tensor4D, convInfo: Conv2DInfo):
      Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const dilations = [1, convInfo.dilationHeight, convInfo.dilationWidth, 1];
    const opAttrs = [
      createTypeOpAttr('T', input.dtype),
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'dilations', type: this.binding.TF_ATTR_INT, value: dilations}
    ];
    return this.executeSingleOutput(
               'DepthwiseConv2dNative', opAttrs, [input, filter]) as Tensor4D;
  }

  maxPool(x: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const ksize = [1, convInfo.filterHeight, convInfo.filterWidth, 1];
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'ksize', type: this.binding.TF_ATTR_INT, value: ksize},
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding}, {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      }
    ];
    return this.executeSingleOutput('MaxPool', opAttrs, [x]) as Tensor4D;
  }

  maxPoolBackprop(dy: Tensor4D, x: Tensor4D, y: Tensor4D, convInfo: Conv2DInfo):
      Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding type was ${convInfo.padInfo.type}`);
    }
    const ksize = [1, convInfo.filterHeight, convInfo.filterWidth, 1];
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'ksize', type: this.binding.TF_ATTR_INT, value: ksize},
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding},
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
    ];
    return this.executeSingleOutput('MaxPoolGrad', opAttrs, [x, y, dy]) as
        Tensor4D;
  }

  avgPool(x: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding was ${convInfo.padInfo.type}`);
    }
    const ksize = [1, convInfo.filterHeight, convInfo.filterWidth, 1];
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'ksize', type: this.binding.TF_ATTR_INT, value: ksize},
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding},
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
    ];
    return this.executeSingleOutput('AvgPool', opAttrs, [x]) as Tensor4D;
  }

  avgPoolBackprop(dy: Tensor4D, x: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    if (convInfo.padInfo.type !== 'VALID' && convInfo.padInfo.type !== 'SAME') {
      throw new Error(
          `TF Backend supports only 'valid' and 'same' padding ` +
          `while padding type was ${convInfo.padInfo.type}`);
    }
    const ksize = [1, convInfo.filterHeight, convInfo.filterWidth, 1];
    const strides = [1, convInfo.strideHeight, convInfo.strideWidth, 1];
    const padding = convInfo.padInfo.type;
    const dataFormat = convInfo.dataFormat === 'channelsLast' ? 'NHWC' : 'NCHW';
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'ksize', type: this.binding.TF_ATTR_INT, value: ksize},
      {name: 'strides', type: this.binding.TF_ATTR_INT, value: strides},
      {name: 'padding', type: this.binding.TF_ATTR_STRING, value: padding},
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
    ];
    const origInputShape = tensor1d(x.shape, 'int32');
    return this.executeSingleOutput(
               'AvgPoolGrad', opAttrs, [origInputShape, dy]) as Tensor4D;
  }

  reshape<T extends Tensor, R extends Rank>(x: T, shape: ShapeMap[R]):
      Tensor<R> {
    const shapeTensor = tensor1d(shape, 'int32');

    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      createTypeOpAttr('Tshape', shapeTensor.dtype)
    ];
    return this.executeSingleOutput('Reshape', opAttrs, [x, shapeTensor]) as
        Tensor<R>;
  }

  cast<T extends Tensor>(x: T, dtype: DataType): T {
    const opAttrs =
        [createTypeOpAttr('SrcT', x.dtype), createTypeOpAttr('DstT', dtype)];
    return this.executeSingleOutput('Cast', opAttrs, [x]) as T;
  }

  tile<T extends Tensor>(x: T, reps: number[]): T {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tmultiples', 'int32')
    ];
    const multiples = tensor1d(reps, 'int32');
    return this.executeSingleOutput('Tile', opAttrs, [x, multiples]) as T;
  }

  pad<T extends Tensor>(
      x: T, paddings: Array<[number, number]>, constantValue: number): T {
    // Bind tensor values
    const paddingsTensor = tensor2d(paddings, [paddings.length, 2], 'int32');
    const constantTensor = scalar(constantValue, x.dtype);

    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      createTypeOpAttr('Tpaddings', paddingsTensor.dtype)
    ];

    return this.executeSingleOutput(
               'PadV2', opAttrs, [x, paddingsTensor, constantTensor]) as T;
  }

  transpose<T extends Tensor>(x: T, perm: number[]): T {
    const permTensor = tensor1d(perm, 'int32');
    const opAttrs =
        [createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tperm', 'int32')];
    return this.executeSingleOutput('Transpose', opAttrs, [x, permTensor]) as T;
  }

  gather<T extends Tensor>(x: T, indices: Tensor1D, axis: number): T {
    const axisTensor = scalar(axis, 'int32');
    const opAttrs = [
      createTypeOpAttr('Tparams', x.dtype),
      createTypeOpAttr('Tindices', indices.dtype),
      createTypeOpAttr('Taxis', 'int32')
    ];
    return this.executeSingleOutput(
               'GatherV2', opAttrs, [x, indices, axisTensor]) as T;
  }

  batchToSpaceND<T extends Tensor>(
      x: T, blockShape: number[], crops: number[][]): T {
    const blockShapeTensor = tensor1d(blockShape, 'int32');
    const cropsTensor =
        tensor2d(crops, [crops.length, crops[0].length], 'int32');
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tblock_shape', 'int32'),
      createTypeOpAttr('Tcrops', cropsTensor.dtype)
    ];
    return this.executeSingleOutput(
               'BatchToSpaceND', opAttrs, [x, blockShapeTensor, cropsTensor]) as
        T;
  }

  spaceToBatchND<T extends Tensor>(
      x: T, blockShape: number[], paddings: number[][]): T {
    const blockShapeTensor = tensor1d(blockShape, 'int32');
    const paddingsTensor =
        tensor2d(paddings, [paddings.length, paddings[0].length], 'int32');
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tblock_shape', 'int32'),
      createTypeOpAttr('Tpaddings', paddingsTensor.dtype)
    ];
    return this.executeSingleOutput(
               'SpaceToBatchND', opAttrs,
               [x, blockShapeTensor, paddingsTensor]) as T;
  }

  resizeBilinear(
      x: Tensor4D, newHeight: number, newWidth: number,
      alignCorners: boolean): Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {
        name: 'align_corners',
        type: this.binding.TF_ATTR_BOOL,
        value: alignCorners
      },
    ];
    const size = tensor1d([newHeight, newWidth], 'int32');
    return this.executeSingleOutput('ResizeBilinear', opAttrs, [x, size]) as
        Tensor4D;
  }

  resizeBilinearBackprop(dy: Tensor4D, x: Tensor4D, alignCorners: boolean):
      Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), {
        name: 'align_corners',
        type: this.binding.TF_ATTR_BOOL,
        value: alignCorners
      }
    ];
    return this.executeSingleOutput('ResizeBilinearGrad', opAttrs, [dy, x]) as
        Tensor4D;
  }

  resizeNearestNeighbor(
      x: Tensor4D, newHeight: number, newWidth: number,
      alignCorners: boolean): Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {
        name: 'align_corners',
        type: this.binding.TF_ATTR_BOOL,
        value: alignCorners
      },
    ];
    const size = tensor1d([newHeight, newWidth], 'int32');
    return this.executeSingleOutput(
               'ResizeNearestNeighbor', opAttrs, [x, size]) as Tensor4D;
  }

  resizeNearestNeighborBackprop(
      dy: Tensor4D, x: Tensor4D, alignCorners: boolean): Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype), {
        name: 'align_corners',
        type: this.binding.TF_ATTR_BOOL,
        value: alignCorners
      }
    ];
    const [, origHeight, origWidth, ] = x.shape;
    const size = tensor1d([origHeight, origWidth], 'int32');
    return this.executeSingleOutput(
               'ResizeNearestNeighborGrad', opAttrs, [dy, size]) as Tensor4D;
  }

  batchNormalization(
      x: Tensor4D, mean: Tensor1D|Tensor4D, variance: Tensor1D|Tensor4D,
      varianceEpsilon: number, scale?: Tensor1D|Tensor4D,
      offset?: Tensor1D|Tensor4D): Tensor4D {
    if (mean.rank > 1) {
      // Fused batch norm doesn't work with high-dim mean/var/scale/offset.
      let inv = rsqrt(variance.add(scalar(varianceEpsilon)));
      if (scale != null) {
        inv = inv.mul(scale);
      }
      const xNorm = x.sub(mean).mul(inv) as Tensor4D;
      return offset != null ? xNorm.add(offset) : xNorm;
    }
    const dataFormat = 'NHWC';
    const depth = x.shape[3];
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {
        name: 'epsilon',
        type: this.binding.TF_ATTR_FLOAT,
        value: varianceEpsilon
      },
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      },
      {name: 'is_training', type: this.binding.TF_ATTR_BOOL, value: false},
    ];
    const numOutputs = 5;
    if (scale == null) {
      scale = fill([depth], 1) as Tensor1D;
    }
    if (offset == null) {
      offset = fill([depth], 0) as Tensor1D;
    }
    return this.executeMultipleOutputs(
               'FusedBatchNorm', opAttrs, [x, scale, offset, mean, variance],
               numOutputs)[0] as Tensor4D;
  }

  localResponseNormalization4D(
      x: Tensor4D, radius: number, bias: number, alpha: number,
      beta: number): Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', x.dtype),
      {name: 'depth_radius', type: this.binding.TF_ATTR_INT, value: radius},
      {name: 'bias', type: this.binding.TF_ATTR_FLOAT, value: bias},
      {name: 'alpha', type: this.binding.TF_ATTR_FLOAT, value: alpha},
      {name: 'beta', type: this.binding.TF_ATTR_FLOAT, value: beta},
    ];
    return this.executeSingleOutput('LRN', opAttrs, [x]) as Tensor4D;
  }

  LRNGrad(
      dy: Tensor4D, inputImage: Tensor4D, outputImage: Tensor4D, radius: number,
      bias: number, alpha: number, beta: number): Tensor4D {
    const opAttrs = [
      createTypeOpAttr('T', dy.dtype),
      {name: 'depth_radius', type: this.binding.TF_ATTR_INT, value: radius},
      {name: 'bias', type: this.binding.TF_ATTR_FLOAT, value: bias},
      {name: 'alpha', type: this.binding.TF_ATTR_FLOAT, value: alpha},
      {name: 'beta', type: this.binding.TF_ATTR_FLOAT, value: beta},
    ];
    return this.executeSingleOutput(
               'LRNGrad', opAttrs, [dy, inputImage, outputImage]) as Tensor4D;
  }

  multinomial(
      logits: Tensor2D, normalized: boolean, numSamples: number,
      seed: number): Tensor2D {
    if (normalized) {
      throw new Error(
          'TF Node backend does not support normalized logits ' +
          'passed to multinomial');
    }
    const opAttrs = [
      createTypeOpAttr('T', logits.dtype),
      createTypeOpAttr('output_dtype', 'int32'),
      {name: 'seed', type: this.binding.TF_ATTR_INT, value: seed},
      {name: 'seed2', type: this.binding.TF_ATTR_INT, value: seed * seed},
    ];
    return this.executeSingleOutput(
               'Multinomial', opAttrs, [logits, scalar(numSamples, 'int32')]) as
        Tensor2D;
  }

  oneHot(indices: Tensor1D, depth: number, onValue: number, offValue: number):
      Tensor2D {
    const depthTensor = scalar(depth, 'int32');
    const onValueTensor = scalar(onValue, 'int32');
    const offValueTensor = scalar(offValue, 'int32');

    const opAttrs = [
      {name: 'axis', type: this.binding.TF_ATTR_INT, value: -1},
      createTypeOpAttr('T', indices.dtype),
      createTypeOpAttr('TI', indices.dtype)
    ];

    return this.executeSingleOutput('OneHot', opAttrs, [
      indices, depthTensor, onValueTensor, offValueTensor
    ]) as Tensor2D;
  }

  cumsum(x: Tensor, axis: number, exclusive: boolean, reverse: boolean):
      Tensor {
    const axisTensor = scalar(axis, 'int32');
    const opAttrs = [
      {name: 'exclusive', type: this.binding.TF_ATTR_BOOL, value: exclusive},
      {name: 'reverse', type: this.binding.TF_ATTR_BOOL, value: reverse},
      createTypeOpAttr('T', x.dtype), createTypeOpAttr('Tidx', 'int32')
    ];
    return this.executeSingleOutput('Cumsum', opAttrs, [x, axisTensor]);
  }

  nonMaxSuppression(
      boxes: Tensor2D, scores: Tensor1D, maxOutputSize: number,
      iouThreshold?: number, scoreThreshold?: number): Tensor1D {
    const opAttrs = [] as TFEOpAttr[];

    const maxOutputSizeTensor = scalar(maxOutputSize, 'int32');
    const iouThresholdTensor = scalar(iouThreshold);
    const scoreThresholdTensor = scalar(scoreThreshold);
    return this.executeSingleOutput('NonMaxSuppressionV3', opAttrs, [
      boxes, scores, maxOutputSizeTensor, iouThresholdTensor,
      scoreThresholdTensor
    ]) as Tensor1D;
  }

  complex<T extends Tensor<Rank>>(real: T, imag: T): T {
    const opAttrs = [
      createTensorsTypeOpAttr('T', real),
      {
        name: 'Tout',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_COMPLEX64
      },
    ];
    const inputs = [real, imag];
    return this.executeSingleOutput('Complex', opAttrs, inputs) as T;
  }

  real<T extends Tensor<Rank>>(input: T): T {
    const opAttrs = [
      createTensorsTypeOpAttr('T', input), {
        name: 'Tout',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_FLOAT
      }
    ];
    const inputs = [input];
    return this.executeSingleOutput('Real', opAttrs, inputs) as T;
  }

  imag<T extends Tensor<Rank>>(input: T): T {
    const opAttrs = [
      {
        name: 'T',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_COMPLEX64
      },
      {
        name: 'Tout',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_FLOAT
      }
    ];
    const inputs = [input];
    return this.executeSingleOutput('Imag', opAttrs, inputs) as T;
  }

  cropAndResize(
      image: Tensor<Rank.R4>, boxes: Tensor<Rank.R2>, boxIndex: Tensor<Rank.R1>,
      cropSize: [number, number], method: 'bilinear'|'nearest',
      extrapolationValue: number): Tensor<Rank.R4> {
    const opAttrs = [
      createTypeOpAttr('T', image.dtype),
      {name: 'method', type: this.binding.TF_ATTR_STRING, value: method}, {
        name: 'extrapolation_value',
        type: this.binding.TF_ATTR_FLOAT,
        value: extrapolationValue
      }
    ];
    const cropSizeTensor = tensor1d(cropSize, 'int32');
    return this.executeSingleOutput(
               'CropAndResize', opAttrs,
               [image, boxes, boxIndex, cropSizeTensor]) as Tensor<Rank.R4>;
  }

  depthToSpace(x: Tensor<Rank.R4>, blockSize: number, dataFormat: string):
      Tensor<Rank.R4> {
    const opAttrs = [
      createTensorsTypeOpAttr('T', x), {
        name: 'block_size',
        type: this.binding.TF_ATTR_INT,
        value: blockSize < 2 ? 2 : blockSize
      },
      {
        name: 'data_format',
        type: this.binding.TF_ATTR_STRING,
        value: dataFormat
      }
    ];
    const inputs = [x];
    return this.executeSingleOutput('DepthToSpace', opAttrs, inputs) as
        Tensor<Rank.R4>;
  }

  split<T extends Tensor<Rank>>(value: T, sizeSplits: number[], axis: number):
      T[] {
    const opAttrs = [
      {
        name: 'num_split',
        type: this.binding.TF_ATTR_INT,
        value: sizeSplits.length
      },
      createTensorsTypeOpAttr('T', value), {
        name: 'Tlen',
        type: this.binding.TF_ATTR_TYPE,
        value: this.binding.TF_INT32
      }
    ];
    const inputs = [value];
    inputs.push(tensor1d(sizeSplits, 'int32') as T);
    inputs.push(scalar(axis, 'int32') as T);
    return this.executeMultipleOutputs(
               'SplitV', opAttrs, inputs, sizeSplits.length) as T[];
  }

  fromPixels(
      pixels: ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement,
      numChannels: number): Tensor3D {
    if (pixels == null) {
      throw new Error('pixels passed to tf.fromPixels() can not be null');
    }
    // tslint:disable-next-line:no-any
    if ((pixels as any).getContext == null) {
      throw new Error(
          'When running in node, pixels must be an HTMLCanvasElement ' +
          'like the one returned by the `canvas` npm package');
    }
    const vals: Uint8ClampedArray =
        // tslint:disable-next-line:no-any
        (pixels as any)
            .getContext('2d')
            .getImageData(0, 0, pixels.width, pixels.height)
            .data;
    let values: Int32Array;
    if (numChannels === 4) {
      values = new Int32Array(vals);
    } else {
      const numPixels = pixels.width * pixels.height;
      values = new Int32Array(numPixels * numChannels);
      for (let i = 0; i < numPixels; i++) {
        for (let channel = 0; channel < numChannels; ++channel) {
          values[i * numChannels + channel] = vals[i * 4 + channel];
        }
      }
    }
    const outShape: [number, number, number] =
        [pixels.height, pixels.width, numChannels];
    return tensor3d(values, outShape, 'int32');
  }

  memory() {
    // Due to automatic garbage collection, the numbers are unreliable.
    // TODO: Since there is finalization in C, count the true
    // number of undisposed tensors.
    return {unreliable: true};
  }

  async time(f: () => void): Promise<BackendTimingInfo> {
    const start = process.hrtime();
    f();
    // hrtime() returns tuple of [seconds, nanoseconds], and we need to return
    // milliseconds.
    const elapsed = process.hrtime(start);
    return {kernelMs: elapsed[0] * 1000 + elapsed[1] / 1000000};
  }

  isNaN<T extends Tensor>(x: T): T {
    return this.executeSingleInput('IsNan', x) as T;
  }
}
