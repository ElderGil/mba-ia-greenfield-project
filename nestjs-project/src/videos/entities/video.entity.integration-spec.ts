import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(suffix: string): Promise<Channel> {
    const user = await userRepo.save(
      userRepo.create({
        email: `vid_${suffix}@example.com`,
        password: 'hashed-password',
      }),
    );
    return channelRepo.save(
      channelRepo.create({
        name: `Channel ${suffix}`,
        nickname: `chan_${suffix}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a video with default draft status and auto timestamps', async () => {
    const channel = await createChannel('1');

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        short_code: 'AbCdEf12345',
        title: 'Demo Video',
        original_filename: 'demo.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1048576',
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('enforces unique short_code constraint', async () => {
    const channel = await createChannel('2');

    await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        short_code: 'SameCode123',
        title: 'First',
        original_filename: 'first.mp4',
        mime_type: 'video/mp4',
        size_bytes: '1024',
      }),
    );

    await expect(
      videoRepo.save(
        videoRepo.create({
          channel_id: channel.id,
          short_code: 'SameCode123',
          title: 'Second',
          original_filename: 'second.mp4',
          mime_type: 'video/mp4',
          size_bytes: '2048',
        }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('supports 10 GiB bigint size_bytes values without overflow', async () => {
    const channel = await createChannel('3');
    const tenGiB = String(10 * 1024 * 1024 * 1024);

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        short_code: 'TenGig12345',
        title: 'Big File',
        original_filename: 'big.mp4',
        mime_type: 'video/mp4',
        size_bytes: tenGiB,
      }),
    );

    const loaded = await videoRepo.findOneByOrFail({ id: video.id });
    expect(loaded.size_bytes).toBe(tenGiB);
  });
});
