//! Isolated exact renderTile calibration. This binary is never loaded by Irodori.
use serde_json::json;
use std::{
    borrow::Cow,
    fs,
    future::Future,
    path::PathBuf,
    pin::pin,
    sync::{mpsc, Arc},
    task::{Context, Poll, Wake, Waker},
    thread,
    time::Instant,
};

struct ThreadWake(thread::Thread);
impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
fn block_on<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park(),
        }
    }
}
fn completed(device: &wgpu::Device) {
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: None,
        })
        .unwrap();
}
fn ms(at: Instant) -> f64 {
    at.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        5,
        "Expected input directory, width, height, adapter substring."
    );
    let directory = PathBuf::from(&args[1]);
    let width: u32 = args[2].parse().unwrap();
    let height: u32 = args[3].parse().unwrap();
    assert!(width > 0 && width <= 1024 && height > 0 && height <= 1024);
    let columns = width.div_ceil(64);
    let layers = columns * height.div_ceil(64);
    assert!(layers <= 256);
    let source_bytes = fs::read(directory.join("source.f32")).unwrap();
    let tables_bytes = fs::read(directory.join("tables.f32")).unwrap();
    let uniforms = fs::read(directory.join("uniforms.f32")).unwrap();
    let jobs_bytes = fs::read(directory.join("jobs.u32")).unwrap();
    let wgsl = fs::read_to_string(directory.join("render.wgsl")).unwrap();
    assert_eq!(source_bytes.len(), (width * height * 16) as usize);
    assert_eq!(uniforms.len(), 30 * 176);
    assert_eq!(jobs_bytes.len(), (layers * 16) as usize);
    let backend = if cfg!(target_os = "macos") {
        wgpu::Backends::METAL
    } else {
        wgpu::Backends::VULKAN
    };
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backend;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = block_on(instance.enumerate_adapters(backend))
        .into_iter()
        .find(|adapter| {
            let info = adapter.get_info();
            info.device_type != wgpu::DeviceType::Cpu
                && info.name.to_lowercase().contains(&args[4].to_lowercase())
        })
        .expect("No matching hardware adapter. Hardware comparison is incomplete.");
    let info = adapter.get_info();
    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("isolated exact research"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .unwrap();
    let texture_usage = wgpu::TextureUsages::COPY_DST
        | wgpu::TextureUsages::TEXTURE_BINDING
        | wgpu::TextureUsages::STORAGE_BINDING
        | wgpu::TextureUsages::COPY_SRC;
    let texture = |w, h, d| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: d,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: texture_usage,
            view_formats: &[],
        })
    };
    let source = texture(width, height, 1);
    let cached = texture(66, 66, 256);
    let buffer = |size, usage| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size,
            usage,
            mapped_at_creation: false,
        })
    };
    let uniform = buffer(
        176,
        wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    );
    let tables = buffer(
        tables_bytes.len() as u64,
        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    );
    let jobs = buffer(
        256 * 16,
        wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
    );
    let upload_at = Instant::now();
    let strip_rows = (8 * 1024 * 1024 / (width * 16)).max(1);
    for y in (0..height).step_by(strip_rows as usize) {
        let rows = (height - y).min(strip_rows);
        // Match Dawn's independently owned, bounded host transfer slices.
        let strip =
            source_bytes[(y * width * 16) as usize..((y + rows) * width * 16) as usize].to_vec();
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &source,
                mip_level: 0,
                origin: wgpu::Origin3d { x: 0, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            &strip,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 16),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width,
                height: rows,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([]);
        completed(&device);
    }
    queue.write_buffer(&tables, 0, &tables_bytes);
    queue.submit([]);
    completed(&device);
    let upload_ms = ms(upload_at);
    let make_buffer_binding = |binding, uniform| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: if uniform {
                wgpu::BufferBindingType::Uniform
            } else {
                wgpu::BufferBindingType::Storage { read_only: true }
            },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            make_buffer_binding(0, true),
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba32Float,
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                },
                count: None,
            },
            make_buffer_binding(4, false),
            make_buffer_binding(5, false),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let compile_at = Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(Cow::Owned(wgsl)),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some("renderTile"),
        compilation_options: Default::default(),
        cache: None,
    });
    let compile_ms = ms(compile_at);
    let source_view = source.create_view(&Default::default());
    let cached_view = cached.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&source_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&cached_view),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: tables.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: jobs.as_entire_binding(),
            },
        ],
    });
    let render = |frame: usize, batch: usize| {
        let at = Instant::now();
        queue.write_buffer(&uniform, 0, &uniforms[frame * 176..(frame + 1) * 176]);
        let mut submit_ms = 0.0;
        let mut wait_ms = 0.0;
        let mut submissions = 0;
        for chunk in jobs_bytes.chunks(batch * 16) {
            let submission_at = Instant::now();
            queue.write_buffer(&jobs, 0, chunk);
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(9, 9, (chunk.len() / 16) as u32);
            }
            queue.submit([encoder.finish()]);
            submit_ms += ms(submission_at);
            submissions += 1;
            if batch == 8 {
                let wait_at = Instant::now();
                completed(&device);
                wait_ms += ms(wait_at);
            }
        }
        let fence_at = Instant::now();
        completed(&device);
        json!({ "totalMs": ms(at), "submissionMs": submit_ms, "batchWaitMs": wait_ms, "completionFenceMs": ms(fence_at), "submissions": submissions })
    };
    let mut cases = Vec::new();
    for batch in [8, 32, 128] {
        let warmups: Vec<_> = (0..5).map(|i| render(i, batch)).collect();
        for repetition in 0..3 {
            let observations: Vec<_> = (0..30).map(|i| render(i, batch)).collect();
            cases.push(json!({ "batchSize": batch, "repetition": repetition, "warmups": warmups, "observations": observations }));
        }
    }
    // Readback is outside the frame benchmark, following an explicitly neutral frame.
    render(15, 32);
    let readback_at = Instant::now();
    let bytes_per_row = 1280;
    let readback_size = u64::from(bytes_per_row * 66 * layers);
    let readback = buffer(
        readback_size,
        wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
    );
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &cached,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(66),
            },
        },
        wgpu::Extent3d {
            width: 66,
            height: 66,
            depth_or_array_layers: layers,
        },
    );
    queue.submit([encoder.finish()]);
    let (send, receive) = mpsc::sync_channel(1);
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            send.send(result).unwrap();
        });
    completed(&device);
    receive.recv().unwrap().unwrap();
    let readback_data = readback.slice(..).get_mapped_range().unwrap().to_vec();
    readback.unmap();
    let readback_ms = ms(readback_at);
    fs::write(directory.join("wgpu-tiles.f32"), &readback_data).unwrap();
    let report = json!({
        "implementation": "wgpu 30.0.1; safe validated WGSL; no optional features",
        "adapter": { "name": info.name, "vendor": info.vendor, "device": info.device, "deviceType": format!("{:?}", info.device_type), "backend": format!("{:?}", info.backend), "driver": info.driver, "driverInfo": info.driver_info },
        "limits": format!("{:?}", device.limits()), "sourceUploadAndTablesMs": upload_ms, "shaderAndPipelineMs": compile_ms,
        "cases": cases, "readbackBytes": readback_size, "readbackMs": readback_ms,
    });
    fs::write(
        directory.join("wgpu.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    device.destroy();
}
