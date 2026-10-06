import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NEON_CONNECTION } from '../database/database.module.js';
import { MediasService } from './medias.service.js';

describe('MediasService', () => {
  let service: MediasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediasService,
        {
          provide: NEON_CONNECTION,
          useValue: vi.fn(),
        },
        {
          provide: ConfigService,
          useValue: { get: vi.fn() },
        },
      ],
    }).compile();

    service = module.get<MediasService>(MediasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
